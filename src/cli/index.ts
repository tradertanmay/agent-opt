#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  HookLifecycleEvent,
  MemoryCategory,
  OptimizerMode,
  SupportedPlatform,
} from '../types/index.js';
import {
  getAgentOptDir,
  loadConfig,
  saveConfig,
  switchModePreservingCustomSettings,
} from '../config/index.js';
import { AgentOptimizerCore } from '../core/optimizer.js';
import {
  detectInstalledAgents,
  formatPlatformHookOutput,
  installPlatformAdapter,
  parsePlatformHookPayload,
  uninstallPlatformAdapter,
  verifyPlatformInstallation,
} from '../adapters/index.js';
import { AgentOptMcpServer } from '../mcp/server.js';
import { BenchmarkRunner } from '../benchmark/index.js';

const ALL_PLATFORMS: SupportedPlatform[] = [
  'google-antigravity',
  'claude-code',
  'openai-codex',
  'cursor',
];

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function parsePlatformSelectionInput(
  rawInput: string,
  detectedDefaults: SupportedPlatform[]
): SupportedPlatform[] {
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed) {
    return detectedDefaults.length > 0 ? detectedDefaults : ['google-antigravity'];
  }
  if (trimmed === 'all' || trimmed === 'a' || trimmed === '*') {
    return [...ALL_PLATFORMS];
  }
  const indexMap: Record<string, SupportedPlatform> = {
    '1': 'google-antigravity',
    '2': 'claude-code',
    '3': 'openai-codex',
    '4': 'cursor',
    antigravity: 'google-antigravity',
    'google-antigravity': 'google-antigravity',
    agy: 'google-antigravity',
    claude: 'claude-code',
    'claude-code': 'claude-code',
    codex: 'openai-codex',
    'openai-codex': 'openai-codex',
    cursor: 'cursor',
  };
  const selected = new Set<SupportedPlatform>();
  for (const part of trimmed.split(/[\s,]+/)) {
    const mapped = indexMap[part];
    if (mapped) selected.add(mapped);
  }
  return selected.size > 0
    ? Array.from(selected)
    : detectedDefaults.length > 0
      ? detectedDefaults
      : ['google-antigravity'];
}

async function promptForPlatformSelection(
  detectedInfo: ReturnType<typeof detectInstalledAgents>,
  detectedPlatforms: SupportedPlatform[]
): Promise<SupportedPlatform[]> {
  console.log('Detected coding-agent environments:');
  detectedInfo.forEach((info, idx) => {
    const status = info.detected
      ? `DETECTED (${info.reasons.join(', ')})`
      : 'not detected on machine';
    const tier =
      info.validationTier === 'primary-verified'
        ? 'Primary Verified'
        : 'Experimental / Schema-Verified';
    console.log(`  [${idx + 1}] ${info.displayName.padEnd(24)} — ${status} [${tier}]`);
  });

  if (!process.stdin.isTTY) {
    return detectedPlatforms.length > 0 ? detectedPlatforms : ['google-antigravity'];
  }

  return new Promise<SupportedPlatform[]>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const defaultLabel =
      detectedPlatforms.length > 0 ? detectedPlatforms.join(', ') : 'google-antigravity';
    const timer = setTimeout(() => {
      rl.close();
      resolve(detectedPlatforms.length > 0 ? detectedPlatforms : ['google-antigravity']);
    }, 10000);

    rl.question(
      `\nSelect platforms to install (1-4, comma-separated, 'all', or Enter for [${defaultLabel}]): `,
      (answer) => {
        clearTimeout(timer);
        rl.close();
        resolve(parsePlatformSelectionInput(answer, detectedPlatforms));
      }
    );
  });
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] || 'help';
  const cwd = getFlagValue(argv, '--cwd') || process.cwd();

  if (cmd === 'hook') {
    try {
      const rawStdin = await readStdin();
      let parsedPayload: Record<string, unknown> = {};
      if (rawStdin.trim()) {
        try {
          parsedPayload = JSON.parse(rawStdin) as Record<string, unknown>;
        } catch {
          parsedPayload = {};
        }
      }

      const explicitPlatform = getFlagValue(argv, '--platform') as
        | SupportedPlatform
        | undefined;
      const explicitEvent = getFlagValue(argv, '--event') as
        | HookLifecycleEvent
        | undefined;

      const normalizedEvent = parsePlatformHookPayload(
        parsedPayload,
        explicitPlatform,
        explicitEvent,
        cwd
      );

      const core = new AgentOptimizerCore({ cwd: normalizedEvent.cwd });
      const decision = core.handleEvent(normalizedEvent);
      const output = formatPlatformHookOutput(
        normalizedEvent.platform,
        normalizedEvent.event,
        decision
      );

      if (output.stderr) {
        process.stderr.write(output.stderr + '\n');
      }
      if (output.stdout) {
        process.stdout.write(output.stdout + '\n');
      }
      return output.exitCode;
    } catch {
      // Fail-open guarantee: never crash or block the host agent on unexpected internal errors
      process.stdout.write('{}\n');
      return 0;
    }
  }

  if (cmd === 'mcp') {
    const server = new AgentOptMcpServer(cwd);
    await server.startStdio();
    return 0;
  }

  if (cmd === 'init') {
    const explicitPlatformFlag = getFlagValue(argv, '--platform');
    const nonInteractive =
      argv.includes('--yes') || argv.includes('-y') || !process.stdin.isTTY;
    const rawMode = (getFlagValue(argv, '--mode') || '').toUpperCase();

    const detectedInfo = detectInstalledAgents(cwd);
    const detectedPlatforms = detectedInfo
      .filter((d) => d.detected)
      .map((d) => d.platform);

    let platforms: SupportedPlatform[];
    if (explicitPlatformFlag) {
      platforms = parsePlatformSelectionInput(explicitPlatformFlag, detectedPlatforms);
    } else if (!nonInteractive) {
      platforms = await promptForPlatformSelection(detectedInfo, detectedPlatforms);
    } else {
      platforms =
        detectedPlatforms.length > 0 ? detectedPlatforms : ['google-antigravity'];
    }

    const existing = loadConfig(cwd);
    const selectedMode: OptimizerMode =
      rawMode === 'FAST' || rawMode === 'BALANCED' || rawMode === 'STRICT'
        ? (rawMode as OptimizerMode)
        : existing.mode ?? 'FAST';
    const config = switchModePreservingCustomSettings(existing, selectedMode);
    const configPath = saveConfig(cwd, config);
    const core = new AgentOptimizerCore({ cwd, config });
    const memories = core.memoryStore.bootstrapFromWorkspace('init');
    const graph = core.contextEngine.buildRepoGraph();

    const installed: string[] = [configPath];
    for (const p of platforms) {
      const res = installPlatformAdapter(cwd, p);
      installed.push(...res.installedFiles);
    }

    const validations = platforms.map((p) => verifyPlatformInstallation(cwd, p));

    console.log('=== AgentOpt Initialized Successfully ===');
    console.log(`Workspace:        ${cwd}`);
    console.log(`Optimizer Mode:   ${config.mode} (default: FAST; switch with 'aopt mode BALANCED|STRICT')`);
    console.log(`Indexed Files:    ${Object.keys(graph).length} source files`);
    console.log(`Verified Memory:  ${memories.length} project rules/commands bootstrapped`);
    console.log(
      `Detected Agents:  ${
        detectedPlatforms.length > 0 ? detectedPlatforms.join(', ') : 'none (installed default)'
      }`
    );
    console.log(`Platforms Wired:  ${platforms.join(', ')}`);
    for (const f of installed) {
      console.log(`  + ${path.relative(cwd, f) || f}`);
    }
    console.log('Post-Install Validation:');
    for (const v of validations) {
      const ok = v.filesValid && v.hookExecutionPassed;
      console.log(`  [${ok ? 'PASS' : 'WARN'}] ${v.platform}: ${v.details}`);
    }
    return 0;
  }

  if (cmd === 'status') {
    const config = loadConfig(cwd);
    const core = new AgentOptimizerCore({ cwd, config });
    const graph = core.contextEngine.buildRepoGraph();
    const totalSymbols = Object.values(graph).reduce(
      (sum, node) => sum + node.symbols.length,
      0
    );
    const memories = core.memoryStore.loadAll(false);
    const sessions = core.listSessions();
    const detected = detectInstalledAgents(cwd);

    const totalSavedTokens = sessions.reduce(
      (sum, s) => sum + (s.metrics.estimatedInputTokensSaved || 0),
      0
    );
    const totalDedupReads = sessions.reduce(
      (sum, s) => sum + (s.metrics.deduplicatedReads || 0),
      0
    );
    const totalLoopsCaught = sessions.reduce(
      (sum, s) => sum + (s.metrics.loopInterventions || 0),
      0
    );

    console.log('=== AgentOpt Status ===');
    console.log(`Status:              ${config.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Active Mode:         ${config.mode ?? 'FAST'} (FAST | BALANCED | STRICT)`);
    console.log(`Workspace:           ${cwd}`);
    console.log(
      `Repository Index:    ${Object.keys(graph).length} files (${totalSymbols} indexed symbols)`
    );
    console.log(`Verified Memories:   ${memories.length} active entries`);
    console.log(
      `Session Telemetry:   ${sessions.length} sessions | ${totalDedupReads} deduplicated reads | ${totalLoopsCaught} loop interventions | ~${totalSavedTokens} est. tokens saved`
    );
    console.log('Platform Integrations:');
    for (const d of detected) {
      const tierLabel =
        d.validationTier === 'primary-verified'
          ? 'Primary Verified'
          : 'Experimental / Schema-Verified';
      const stateLabel = d.installedInWorkspace
        ? 'INSTALLED'
        : d.detected
          ? 'DETECTED (run `aopt init`)'
          : 'not configured';
      console.log(`  - ${d.displayName.padEnd(24)}: ${stateLabel} [${tierLabel}]`);
    }
    return 0;
  }

  if (cmd === 'mode') {
    const requested = (argv[1] || '').toUpperCase();
    const current = loadConfig(cwd);
    if (!requested || requested.startsWith('--')) {
      console.log(`Current AgentOpt mode in ${cwd}: ${current.mode ?? 'FAST'}`);
      console.log('Available modes: FAST | BALANCED | STRICT');
      return 0;
    }
    if (requested !== 'FAST' && requested !== 'BALANCED' && requested !== 'STRICT') {
      console.error('Usage: aopt mode <FAST|BALANCED|STRICT>');
      return 1;
    }
    const updated = switchModePreservingCustomSettings(
      current,
      requested as OptimizerMode
    );
    saveConfig(cwd, updated);
    console.log(`AgentOpt mode set to ${updated.mode} in ${cwd}.`);
    return 0;
  }

  if (cmd === 'uninstall') {
    const targetPlatform = getFlagValue(argv, '--platform') || 'all';
    const platforms: SupportedPlatform[] =
      targetPlatform === 'all'
        ? [...ALL_PLATFORMS]
        : parsePlatformSelectionInput(targetPlatform, ALL_PLATFORMS);

    const removed: string[] = [];
    for (const p of platforms) {
      const res = uninstallPlatformAdapter(cwd, p);
      removed.push(...res.removedOrUpdatedFiles);
    }

    if (argv.includes('--purge')) {
      const optDir = getAgentOptDir(cwd);
      if (fs.existsSync(optDir)) {
        fs.rmSync(optDir, { recursive: true, force: true });
        removed.push(optDir);
      }
    }

    console.log('=== AgentOpt Uninstalled ===');
    for (const f of removed) {
      console.log(`  - ${path.relative(cwd, f) || f}`);
    }
    return 0;
  }

  if (cmd === 'enable' || cmd === 'disable') {
    const config = loadConfig(cwd);
    config.enabled = cmd === 'enable';
    saveConfig(cwd, config);
    console.log(`AgentOpt is now ${config.enabled ? 'ENABLED' : 'DISABLED'} in ${cwd}.`);
    return 0;
  }

  if (cmd === 'context') {
    const query = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    if (!query) {
      console.error('Usage: aopt context "<task prompt or symbol query>"');
      return 1;
    }
    const core = new AgentOptimizerCore({ cwd });
    const res = core.contextEngine.optimizeForQuery(query);
    console.log(res.compactRepoMap || 'No matching files ranked for query.');
    console.log(
      `\n[Diagnostics] Full Repo Tokens: ~${res.fullRepoTokenCount} | Injected Map Tokens: ${res.injectedTokenCount} | Est. Exploration Tokens Saved: ~${res.estimatedTokensSaved}`
    );
    return 0;
  }

  if (cmd === 'verify') {
    const sessionId = getFlagValue(argv, '--session') || 'default';
    const core = new AgentOptimizerCore({ cwd });
    const session = core.loadOrCreateSession(sessionId);
    const report = core.verificationEngine.evaluate(session);
    console.log(`=== Task Verification Report (Session: ${session.sessionId}) ===`);
    console.log(`Status:              ${report.status}`);
    console.log(`Summary:             ${report.summary}`);
    console.log(
      `Modified Source:     ${report.modifiedSourceFiles.join(', ') || '(none)'}`
    );
    console.log(
      `Dirty (Unverified):  ${report.dirtyFilesSinceLastVerification.join(', ') || '(none)'}`
    );
    console.log(`Recommended Cmds:    ${report.recommendedCommands.join(' | ')}`);
    return 0;
  }

  if (cmd === 'memory') {
    const sub = argv[1] || 'list';
    const core = new AgentOptimizerCore({ cwd });
    if (sub === 'bootstrap') {
      const created = core.memoryStore.bootstrapFromWorkspace('cli');
      console.log(`Bootstrapped ${created.length} verified project memories.`);
      return 0;
    }
    if (sub === 'clear') {
      core.memoryStore.clearAll();
      console.log('Cleared all project memories.');
      return 0;
    }
    if (sub === 'remove' && argv[2]) {
      const ok = core.memoryStore.removeMemory(argv[2]);
      console.log(ok ? `Removed memory '${argv[2]}'.` : `Memory '${argv[2]}' not found.`);
      return ok ? 0 : 1;
    }
    if (sub === 'add') {
      const category = (getFlagValue(argv, '--category') ||
        'debugging_discovery') as MemoryCategory;
      const key = getFlagValue(argv, '--key') || 'custom_note';
      const value = getFlagValue(argv, '--value') || '';
      if (!value) {
        console.error('Usage: aopt memory add --category <cat> --key <key> --value "<fact>"');
        return 1;
      }
      const entry = core.memoryStore.upsertVerifiedMemory({
        category,
        key,
        value,
        confidence: 0.9,
        sourceSessionId: 'cli-manual',
      });
      console.log(`Saved verified memory [${entry.id}] ${entry.key}: ${entry.value}`);
      return 0;
    }

    const entries = core.memoryStore.loadAll(true);
    console.log(`=== Project Memory Store (${entries.length} entries) ===`);
    for (const e of entries) {
      const stateTag = e.invalidated ? '[INVALIDATED]' : `[conf=${e.confidence}]`;
      console.log(`- ${e.id} ${stateTag} (${e.category}) ${e.key}: ${e.value}`);
    }
    return 0;
  }

  if (cmd === 'stats') {
    const core = new AgentOptimizerCore({ cwd });
    const sessions = core.listSessions();
    console.log(`=== AgentOpt Session Telemetry (${sessions.length} recorded sessions) ===`);
    for (const s of sessions.slice(0, 10)) {
      console.log(
        `- Session ${s.sessionId} [${s.platform}] | Steps: ${s.stepCount} | Verification: ${s.metrics.finalVerificationStatus} | ` +
          `Deduplicated Reads: ${s.metrics.deduplicatedReads} | Loop Interventions: ${s.metrics.loopInterventions} | ` +
          `Measured In/Out Tokens: ${s.metrics.measuredInputTokens}/${s.metrics.measuredOutputTokens} | ` +
          `Est. Saved Tokens: ~${s.metrics.estimatedInputTokensSaved} | Hook Overhead: ${s.metrics.totalHookLatencyMs}ms`
      );
    }
    return 0;
  }

  if (cmd === 'doctor') {
    const config = loadConfig(cwd);
    const core = new AgentOptimizerCore({ cwd, config });
    const graph = core.contextEngine.buildRepoGraph();
    const memories = core.memoryStore.loadAll(false);
    const detected = detectInstalledAgents(cwd);

    console.log('=== AgentOpt Diagnostics (Doctor) ===');
    console.log(`Plugin Enabled:      ${config.enabled ? 'YES' : 'NO'}`);
    console.log(`Active Mode:         ${config.mode ?? 'FAST'}`);
    console.log(`Indexed Repo Files:  ${Object.keys(graph).length}`);
    console.log(`Active Memories:     ${memories.length}`);

    for (const d of detected) {
      const check = verifyPlatformInstallation(cwd, d.platform);
      const tier =
        d.validationTier === 'primary-verified'
          ? 'Primary Verified'
          : 'Experimental Adapter';
      if (check.installed) {
        const health =
          check.filesValid && check.hookExecutionPassed ? 'HEALTHY' : 'INVALID';
        console.log(
          `${d.displayName.padEnd(20)}: INSTALLED (${health} — ${check.details}) [${tier}]`
        );
      } else {
        console.log(
          `${d.displayName.padEnd(20)}: not configured${d.detected ? ' (agent detected on system)' : ''}`
        );
      }
    }
    return 0;
  }

  if (cmd === 'benchmark') {
    const runsStr = getFlagValue(argv, '--runs');
    const runsPerTask = runsStr ? Math.max(1, parseInt(runsStr, 10)) : 10;
    const runner = new BenchmarkRunner();
    const { conditions } = runner.runFullSuite(runsPerTask);
    console.log(
      `=== AgentOpt Benchmark Suite (${runsPerTask} repeated runs x 6 tasks = ${runsPerTask * 6} runs/condition) ===\n`
    );
    console.log(
      '| Condition | Completion (%) | Correctness (%) | Input Tokens | Tool Calls | Failed Calls | Latency (ms) | Regressions (%) | Cost/Success ($) |'
    );
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const c of Object.values(conditions)) {
      console.log(
        `| \`${c.condition}\` | ${c.taskCompletionRate.mean.toFixed(1)}% (±${((c.taskCompletionRate.ci95High - c.taskCompletionRate.mean)).toFixed(1)}) | ` +
          `${c.correctnessRate.mean.toFixed(1)}% | ` +
          `${Math.round(c.measuredInputTokens.mean)} (±${Math.round(c.measuredInputTokens.ci95High - c.measuredInputTokens.mean)}) | ` +
          `${c.toolCalls.mean.toFixed(1)} | ${c.failedToolCalls.mean.toFixed(2)} | ` +
          `${Math.round(c.executionLatencyMs.mean)}ms | ${c.regressionRate.mean.toFixed(1)}% | ` +
          `$${c.costPerSuccessfulTaskUsd.toFixed(4)} |`
      );
    }
    return 0;
  }

  console.log(
    [
      'AgentOpt (aopt) — Make your AI coding agent smarter, faster, and more token-efficient.',
      '',
      'Usage:',
      '  npx agent-opt init [--platform google-antigravity|claude-code|openai-codex|cursor|all] [--mode FAST|BALANCED|STRICT] [--yes]',
      '  aopt status',
      '  aopt mode [FAST|BALANCED|STRICT]',
      '  aopt doctor',
      '  aopt context "<task prompt or symbol query>"',
      '  aopt verify [--session <id>]',
      '  aopt memory [list|bootstrap|add|remove|clear]',
      '  aopt stats',
      '  aopt benchmark [--runs 10]',
      '  aopt enable | disable',
      '  aopt uninstall [--platform <p>] [--purge]',
      '  aopt hook --platform <p> --event <e>',
      '  aopt mcp',
    ].join('\n')
  );
  return 0;
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  }
})();

if (isDirectExecution) {
  runCli().then((code) => process.exit(code));
}
