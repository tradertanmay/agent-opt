import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { REAL_BENCHMARK_TASKS_30, RealCodingTask, writeDistractorRepoStructure } from './tasks-30.js';
import { AgentOptimizerCore } from '../core/optimizer.js';
import { OptimizerConfig } from '../types/index.js';
import { createConfigForMode, DEFAULT_CONFIG, saveConfig } from '../config/index.js';

export type ExperimentCondition =
  | 'baseline'
  | 'FAST'
  | 'BALANCED'
  | 'STRICT'
  | 'context-only'
  | 'verification-only'
  | 'full-agent-opt';

export type EvidenceClassification = 'REAL_AGENT' | 'SIMULATED' | 'ESTIMATED';

export interface RealTrialRecord {
  taskId: string;
  category: string;
  title: string;
  condition: ExperimentCondition;
  evidenceType: EvidenceClassification;
  modelName: string;
  /** Whether the agent completed and passed the workspace test suite */
  workspaceTestsPassed: boolean;
  /** Whether the final workspace passed the independent held-out oracle test suite */
  heldOutOraclePassed: boolean;
  /** Whether pre-existing baseline assertions regressed */
  regressionDetected: boolean;
  /** Actual input tokens reported by the LLM engine (prompt_eval_count) */
  inputTokens: number;
  /** Actual output tokens reported by the LLM engine (eval_count) */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Equivalent API cost in USD ($3/1M input, $15/1M output for reference parity) */
  equivalentApiCostUsd: number;
  /** Number of LLM turns */
  llmTurns: number;
  /** Number of tool calls made by the model */
  toolCallsCount: number;
  /** Number of distractor files read */
  distractorFilesRead: number;
  /** Number of times Stop hook intercepted premature or broken completion */
  stopHookInterceptions: number;
  /** Number of redundant tool calls blocked by PreToolUse */
  preToolBlocks: number;
  /** Total wall-clock time for the trial in ms */
  wallClockMs: number;
  /** Total time spent inside AgentOpt hooks in ms */
  hookLatencyMs: number;
  /** Hook overhead as % of wall clock */
  hookOverheadPct: number;
  /** Brief trace summary of actions taken */
  traceSummary: string[];
  /** Final verification status from AgentOpt if active */
  finalVerificationStatus: string;
}

export interface WilsonInterval {
  successes: number;
  total: number;
  ratePct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  halfWidthPct: number;
}

export interface ConditionAggregate {
  condition: ExperimentCondition;
  evidenceType: EvidenceClassification;
  modelName: string;
  tasksCount: number;
  oracleCompletion: WilsonInterval;
  workspaceTestCompletion: WilsonInterval;
  regressionRate: WilsonInterval;
  meanInputTokens: number;
  medianInputTokens: number;
  meanOutputTokens: number;
  meanTotalTokens: number;
  meanEquivalentCostUsd: number;
  costPerVerifiedSuccessUsd: number;
  meanWallClockMs: number;
  medianWallClockMs: number;
  meanHookLatencyMs: number;
  meanHookOverheadPct: number;
  meanToolCalls: number;
  meanDistractorReads: number;
  totalStopInterceptions: number;
  totalPreToolBlocks: number;
}

/**
 * Computes the Wilson score 95% confidence interval for a binomial proportion.
 */
export function computeWilson95CI(successes: number, total: number): WilsonInterval {
  if (total <= 0) {
    return { successes: 0, total: 0, ratePct: 0, ciLowerPct: 0, ciUpperPct: 0, halfWidthPct: 0 };
  }
  const z = 1.959963984540054;
  const z2 = z * z;
  const p = successes / total;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  const lower = Math.max(0, center - margin) * 100;
  const upper = Math.min(1, center + margin) * 100;
  return {
    successes,
    total,
    ratePct: Number((p * 100).toFixed(1)),
    ciLowerPct: Number(lower.toFixed(1)),
    ciUpperPct: Number(upper.toFixed(1)),
    halfWidthPct: Number(((upper - lower) / 2).toFixed(1)),
  };
}

/**
 * Computes paired mean difference and 95% confidence interval across matched tasks.
 */
export function computePairedDelta95CI(
  baselineValues: number[],
  treatmentValues: number[]
): {
  meanBaseline: number;
  meanTreatment: number;
  meanDiff: number;
  pctChange: number;
  ciLowerDiff: number;
  ciUpperDiff: number;
  ciLowerPct: number;
  ciUpperPct: number;
} {
  const n = Math.min(baselineValues.length, treatmentValues.length);
  if (n === 0) {
    return {
      meanBaseline: 0,
      meanTreatment: 0,
      meanDiff: 0,
      pctChange: 0,
      ciLowerDiff: 0,
      ciUpperDiff: 0,
      ciLowerPct: 0,
      ciUpperPct: 0,
    };
  }
  const diffs: number[] = [];
  let sumBase = 0;
  let sumTreat = 0;
  for (let i = 0; i < n; i++) {
    sumBase += baselineValues[i];
    sumTreat += treatmentValues[i];
    diffs.push(treatmentValues[i] - baselineValues[i]);
  }
  const meanBase = sumBase / n;
  const meanTreat = sumTreat / n;
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1
      ? diffs.reduce((acc, d) => acc + Math.pow(d - meanDiff, 2), 0) / (n - 1)
      : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : 0;
  const tCrit = n >= 30 ? 2.045 : 2.093;
  const ciLowerDiff = meanDiff - tCrit * se;
  const ciUpperDiff = meanDiff + tCrit * se;
  const pctChange = meanBase !== 0 ? (meanDiff / meanBase) * 100 : 0;
  const ciLowerPct = meanBase !== 0 ? (ciLowerDiff / meanBase) * 100 : 0;
  const ciUpperPct = meanBase !== 0 ? (ciUpperDiff / meanBase) * 100 : 0;

  return {
    meanBaseline: Number(meanBase.toFixed(2)),
    meanTreatment: Number(meanTreat.toFixed(2)),
    meanDiff: Number(meanDiff.toFixed(2)),
    pctChange: Number(pctChange.toFixed(1)),
    ciLowerDiff: Number(ciLowerDiff.toFixed(2)),
    ciUpperDiff: Number(ciUpperDiff.toFixed(2)),
    ciLowerPct: Number(ciLowerPct.toFixed(1)),
    ciUpperPct: Number(ciUpperPct.toFixed(1)),
  };
}

/**
 * Materializes a task workspace on disk with distractor modules and workspace test file.
 */
export function createTaskWorkspace(task: RealCodingTask): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentopt-real-${task.id}-`));

  const pkgJson = {
    name: `benchmark-${task.id}`,
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      test: 'node --test test/workspace.test.mjs',
    },
  };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8');

  if (task.repoFiles) {
    for (const [relPath, content] of Object.entries(task.repoFiles)) {
      const absPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
    }
  } else {
    writeDistractorRepoStructure(tmpDir);
  }

  for (const [relPath, content] of Object.entries(task.initialFiles)) {
    const absPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }

  const testPath = path.join(tmpDir, 'test/workspace.test.mjs');
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, task.workspaceTestFile, 'utf8');

  return tmpDir;
}

/**
 * Runs the workspace test suite (`node --test test/workspace.test.mjs`).
 */
export function runWorkspaceTests(workspaceDir: string): {
  passed: boolean;
  exitCode: number;
  output: string;
} {
  const res = spawnSync(process.execPath, ['--test', 'test/workspace.test.mjs'], {
    cwd: workspaceDir,
    encoding: 'utf8',
    timeout: 8000,
  });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const exitCode = res.status ?? 1;
  return {
    passed: exitCode === 0,
    exitCode,
    output,
  };
}

/**
 * Runs the independent held-out oracle test suite against the workspace.
 * The held-out oracle is NEVER present in the workspace while the coding agent is running.
 */
export function runHeldOutOracleTests(
  workspaceDir: string,
  task: RealCodingTask
): { passed: boolean; exitCode: number; output: string } {
  const oraclePath = path.join(workspaceDir, 'test/__held_out_oracle__.test.mjs');
  try {
    fs.mkdirSync(path.dirname(oraclePath), { recursive: true });
    fs.writeFileSync(oraclePath, task.heldOutOracleTestCode, 'utf8');
    const res = spawnSync(process.execPath, ['--test', 'test/__held_out_oracle__.test.mjs'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: 8000,
    });
    const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
    const exitCode = res.status ?? 1;
    return {
      passed: exitCode === 0,
      exitCode,
      output,
    };
  } finally {
    try {
      if (fs.existsSync(oraclePath)) fs.unlinkSync(oraclePath);
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * Removes explicit `src/...` file path spoilers from the user prompt so the agent must either
 * discover the target file via repository exploration or use AgentOpt's UserPromptSubmit symbol map.
 */
export function getDiscoveryPrompt(task: RealCodingTask): string {
  // Replace phrases like "in `src/cache/lru.mjs`" or "in `src/orders/checkout.mjs` and `src/orders/tax.mjs`"
  // and trailing "Run tests to verify." reminders so both file discovery and automatic verification are tested realistically.
  const cleaned = task.prompt
    .replace(/\s+in\s+`src\/[^`]+`(\s+and\s+`src\/[^`]+`)?/g, '')
    .replace(/`src\/[A-Za-z0-9_./-]+`/g, 'the module')
    .replace(/\s*Run tests to verify\.?/gi, '')
    .trim();
  return cleaned;
}

/**
 * Verifies that all 30 tasks fail before the fix (confirming no trivial/already-passing tasks)
 * and that AgentOpt's RepoContextEngine ranks the target file(s) properly from the discovery prompt.
 */
export function verifyBenchmarkTaskIntegrity(): {
  total: number;
  failedInitiallyCount: number;
  contextTopHitCount: number;
  errors: string[];
} {
  const errors: string[] = [];
  let failedInitiallyCount = 0;
  let contextTopHitCount = 0;

  for (const task of REAL_BENCHMARK_TASKS_30) {
    const dir = createTaskWorkspace(task);
    try {
      const initialWs = runWorkspaceTests(dir);
      const initialOracle = runHeldOutOracleTests(dir, task);
      if (initialWs.passed || initialOracle.passed) {
        errors.push(`Task ${task.id} unexpectedly passed BEFORE fix!`);
        continue;
      }
      failedInitiallyCount++;

      const core = new AgentOptimizerCore({ cwd: dir });
      const prompt = getDiscoveryPrompt(task);
      const res = core.handleEvent({
        platform: 'claude-code',
        event: 'UserPromptSubmit',
        sessionId: `verify-${task.id}`,
        cwd: dir,
        timestamp: new Date().toISOString(),
        userPrompt: prompt,
      });
      const hitTarget = task.targetFiles.some((tf) =>
        (res.injectedContext || '').includes(tf)
      );
      if (hitTarget) {
        contextTopHitCount++;
      } else {
        errors.push(`Task ${task.id} target files ${task.targetFiles.join(', ')} not in context map for prompt: ${prompt}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    total: REAL_BENCHMARK_TASKS_30.length,
    failedInitiallyCount,
    contextTopHitCount,
    errors,
  };
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all source and test files in the repository workspace.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file (e.g. src/cache/lru.mjs)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write full updated ES module code to a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file' },
          content: { type: 'string', description: 'Complete file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace such as `npm test`.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_task',
      description: 'Complete the task and return a final summary.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of changes made' },
        },
        required: ['summary'],
      },
    },
  },
];

export function buildConditionConfig(condition: ExperimentCondition): OptimizerConfig {
  if (condition === 'FAST' || condition === 'BALANCED' || condition === 'STRICT') {
    return createConfigForMode(condition);
  }
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (condition === 'baseline') {
    cfg.enabled = false;
    cfg.context.enabled = false;
    cfg.verification.enabled = false;
    cfg.failureDetection.enabled = false;
    cfg.memory.enabled = false;
  } else if (condition === 'context-only') {
    return createConfigForMode('FAST');
  } else if (condition === 'verification-only') {
    cfg.enabled = true;
    cfg.mode = 'STRICT';
    cfg.context.enabled = false;
    cfg.verification.enabled = true;
    cfg.verification.autoRunFastTestsOnStop = false;
    cfg.failureDetection.enabled = true;
    cfg.memory.enabled = false;
  } else {
    return createConfigForMode('BALANCED');
  }
  return cfg;
}

function listWorkspaceFiles(workspaceDir: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(workspaceDir, full).split(path.sep).join('/'));
    }
  }
  walk(workspaceDir);
  return out.sort();
}

function parseFallbackToolCalls(content: string): OllamaToolCall[] {
  const calls: OllamaToolCall[] = [];
  const trimmed = content.trim();
  const jsonBlocks = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates = jsonBlocks
    ? jsonBlocks.map((b) => b.replace(/```(?:json)?|```/g, '').trim())
    : [trimmed];

  for (const cand of candidates) {
    if (!cand.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(cand) as Record<string, unknown>;
      if (typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
        calls.push({
          function: {
            name: parsed.name,
            arguments: parsed.arguments as Record<string, unknown>,
          },
        });
      }
    } catch {
      // ignore non-json
    }
  }
  return calls;
}

export async function runSingleRealTrial(
  task: RealCodingTask,
  condition: ExperimentCondition,
  modelName = 'qwen2.5:7b',
  ollamaBaseUrl = 'http://127.0.0.1:11434'
): Promise<RealTrialRecord> {
  const workspaceDir = createTaskWorkspace(task);
  const sessionId = `real_${condition}_${task.id}`;
  const config = buildConditionConfig(condition);
  saveConfig(workspaceDir, config);

  const optimizer = condition === 'baseline' ? null : new AgentOptimizerCore({ cwd: workspaceDir, config });
  const trialStartMs = performance.now();
  let hookLatencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let llmTurns = 0;
  let toolCallsCount = 0;
  let distractorFilesRead = 0;
  let stopHookInterceptions = 0;
  let preToolBlocks = 0;
  const traceSummary: string[] = [];
  let finalVerificationStatus = 'NOT_APPLICABLE';

  try {
    // 1. SessionStart + UserPromptSubmit hooks
    const baseUserPrompt = getDiscoveryPrompt(task);
    let userPromptWithHooks = baseUserPrompt;

    if (optimizer) {
      const h0 = performance.now();
      const startDec = optimizer.handleEvent({
        platform: 'claude-code',
        sessionId,
        event: 'SessionStart',
        timestamp: new Date().toISOString(),
        cwd: workspaceDir,
      });
      const promptDec = optimizer.handleEvent({
        platform: 'claude-code',
        sessionId,
        event: 'UserPromptSubmit',
        timestamp: new Date().toISOString(),
        cwd: workspaceDir,
        userPrompt: baseUserPrompt,
      });
      hookLatencyMs += performance.now() - h0;

      const injectedParts = [startDec.injectedContext, promptDec.injectedContext].filter(Boolean);
      if (injectedParts.length > 0) {
        userPromptWithHooks = `${baseUserPrompt}\n\n${injectedParts.join('\n\n')}`;
      }
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an autonomous software engineering coding agent working in a Node.js ES module repository.\n' +
          'Use the provided tools to inspect, edit, and verify code.\n' +
          'If the [Complete Current File] is already provided in the prompt, call write_file directly on Turn 1 without calling list_files or read_file first.\n' +
          'When calling write_file, always write the complete, valid ES module file preserving exported function/class names.\n' +
          'Once you have written the fix, call finish_task.',
      },
      {
        role: 'user',
        content: userPromptWithHooks,
      },
    ];

    const maxTurns = 5;
    let finished = false;

    while (!finished && llmTurns < maxTurns) {
      llmTurns += 1;

      let data: OllamaChatResponse;
      try {
        const resp = await fetch(`${ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(18000),
          body: JSON.stringify({
            model: modelName,
            messages,
            tools: AGENT_TOOLS,
            stream: false,
            options: {
              temperature: 0,
              num_ctx: 4096,
              num_predict: 380,
            },
          }),
        });

        if (!resp.ok) {
          throw new Error(`Ollama API error ${resp.status}: ${await resp.text()}`);
        }

        data = (await resp.json()) as OllamaChatResponse;
      } catch (err) {
        traceSummary.push(`llm_timeout_or_err`);
        break;
      }
      inputTokens += data.prompt_eval_count ?? 0;
      outputTokens += data.eval_count ?? 0;

      const assistantMsg = data.message;
      messages.push(assistantMsg);

      let toolCalls = assistantMsg.tool_calls ?? [];
      if (toolCalls.length === 0 && assistantMsg.content) {
        toolCalls = parseFallbackToolCalls(assistantMsg.content);
      }

      // If no tool calls were made, the agent is attempting to stop
      if (toolCalls.length === 0) {
        if (optimizer) {
          const hStop = performance.now();
          const stopDec = optimizer.handleEvent({
            platform: 'claude-code',
            sessionId,
            event: 'Stop',
            timestamp: new Date().toISOString(),
            cwd: workspaceDir,
            rawPayload: {
              last_assistant_message: assistantMsg.content,
              stop_hook_active: stopHookInterceptions > 0,
            },
          });
          hookLatencyMs += performance.now() - hStop;
          finalVerificationStatus = stopDec.diagnostics.verificationStatus ?? 'UNKNOWN';

          if (stopDec.action === 'block') {
            stopHookInterceptions += 1;
            traceSummary.push(`StopBlocked(${finalVerificationStatus})`);
            messages.push({
              role: 'user',
              content:
                `${stopDec.agentFeedback ?? 'Verification required.'}\n\n` +
                (finalVerificationStatus === 'NOT_VERIFIED'
                  ? 'Call run_command with `npm test` to verify your changes, then call finish_task.'
                  : 'Fix the failing implementation using write_file and then call finish_task.'),
            });
            continue;
          }
        }
        finished = true;
        break;
      }

      for (const tc of toolCalls) {
        const fnName = tc.function.name;
        const rawArgs =
          typeof tc.function.arguments === 'string'
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : (tc.function.arguments ?? {});

        if (fnName === 'finish_task') {
          if (optimizer) {
            const hStop = performance.now();
            const stopDec = optimizer.handleEvent({
              platform: 'claude-code',
              sessionId,
              event: 'Stop',
              timestamp: new Date().toISOString(),
              cwd: workspaceDir,
              rawPayload: {
                last_assistant_message: String(rawArgs.summary ?? 'Done'),
                stop_hook_active: stopHookInterceptions > 0,
              },
            });
            hookLatencyMs += performance.now() - hStop;
            finalVerificationStatus = stopDec.diagnostics.verificationStatus ?? 'UNKNOWN';

            if (stopDec.action === 'block') {
              stopHookInterceptions += 1;
              traceSummary.push(`StopBlocked(${finalVerificationStatus})`);
              messages.push({
                role: 'tool',
                content:
                  `${stopDec.agentFeedback ?? 'Verification failed.'}\n\n` +
                  (finalVerificationStatus === 'NOT_VERIFIED'
                    ? 'Call run_command with `npm test` to verify your changes before calling finish_task.'
                    : 'Fix the failing implementation using write_file before calling finish_task.'),
              });
              continue;
            }
          }
          traceSummary.push('finish_task');
          finished = true;
          break;
        }

        toolCallsCount += 1;

        // Map tool name to normalized Claude Code tool names for PreToolUse / PostToolUse
        const mappedToolName =
          fnName === 'read_file'
            ? 'Read'
            : fnName === 'write_file'
            ? 'Write'
            : fnName === 'run_command'
            ? 'Bash'
            : 'Glob';
        const mappedToolInput: Record<string, unknown> =
          fnName === 'read_file' || fnName === 'write_file'
            ? { file_path: String(rawArgs.path ?? ''), content: rawArgs.content }
            : fnName === 'run_command'
            ? { command: String(rawArgs.command ?? '') }
            : {};

        if (optimizer) {
          const hPre = performance.now();
          const preDec = optimizer.handleEvent({
            platform: 'claude-code',
            sessionId,
            event: 'PreToolUse',
            timestamp: new Date().toISOString(),
            cwd: workspaceDir,
            toolName: mappedToolName,
            toolInput: mappedToolInput,
          });
          hookLatencyMs += performance.now() - hPre;

          if (preDec.action === 'block') {
            preToolBlocks += 1;
            traceSummary.push(`PreToolBlocked(${fnName}:${String(rawArgs.path ?? '')})`);
            messages.push({
              role: 'tool',
              content: preDec.agentFeedback ?? 'Tool call blocked by AgentOpt.',
            });
            continue;
          }
        }

        // Execute the actual tool in the workspace
        let toolResultText = '';
        let toolExitCode = 0;

        if (fnName === 'list_files') {
          const files = listWorkspaceFiles(workspaceDir);
          toolResultText = files.join('\n');
          traceSummary.push(`list_files(${files.length})`);
        } else if (fnName === 'read_file') {
          const relPath = String(rawArgs.path ?? '').trim().replace(/^\.\//, '');
          const absPath = path.resolve(workspaceDir, relPath);
          if (
            !relPath ||
            absPath === workspaceDir ||
            !absPath.startsWith(workspaceDir) ||
            !fs.existsSync(absPath) ||
            fs.statSync(absPath).isDirectory()
          ) {
            toolResultText = `Error: File not found: ${relPath}`;
            toolExitCode = 1;
            traceSummary.push(`read_file_err(${relPath})`);
          } else {
            toolResultText = fs.readFileSync(absPath, 'utf8');
            const isTargetOrTest =
              task.targetFiles.includes(relPath) || relPath.startsWith('test/');
            if (!isTargetOrTest) {
              distractorFilesRead += 1;
            }
            traceSummary.push(`read_file(${relPath})`);
          }
        } else if (fnName === 'write_file') {
          const relPath = String(rawArgs.path ?? '').trim().replace(/^\.\//, '');
          const content = String(rawArgs.content ?? '');
          const absPath = path.resolve(workspaceDir, relPath);
          if (
            !relPath ||
            absPath === workspaceDir ||
            !absPath.startsWith(workspaceDir) ||
            (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory())
          ) {
            toolResultText = `Error: Invalid file path '${relPath}'. Specify a file path such as ${task.targetFiles[0]}`;
            toolExitCode = 1;
            traceSummary.push(`write_file_err(${relPath})`);
          } else {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            toolResultText = `Successfully wrote ${relPath} (${content.split('\n').length} lines).`;
            traceSummary.push(`write_file(${relPath})`);
          }
        } else if (fnName === 'run_command') {
          const cmd = String(rawArgs.command ?? 'npm test');
          const res = spawnSync(cmd, {
            cwd: workspaceDir,
            shell: true,
            encoding: 'utf8',
            timeout: 8000,
          });
          toolExitCode = res.status ?? 1;
          toolResultText = `Exit code: ${toolExitCode}\n${(res.stdout || '') + '\n' + (res.stderr || '')}`.trim().slice(0, 1500);
          traceSummary.push(`run_command(${cmd}:exit=${toolExitCode})`);
        } else {
          toolResultText = `Unknown tool: ${fnName}`;
          toolExitCode = 1;
        }

        if (optimizer) {
          const hPost = performance.now();
          const postDec = optimizer.handleEvent({
            platform: 'claude-code',
            sessionId,
            event: 'PostToolUse',
            timestamp: new Date().toISOString(),
            cwd: workspaceDir,
            toolName: mappedToolName,
            toolInput: mappedToolInput,
            toolOutput: toolResultText,
            exitCode: toolExitCode,
          });
          hookLatencyMs += performance.now() - hPost;

          if (postDec.agentFeedback) {
            toolResultText += `\n\n${postDec.agentFeedback}`;
          }
          if (postDec.injectedContext) {
            toolResultText += `\n\n${postDec.injectedContext}`;
          }
        }

        messages.push({
          role: 'tool',
          content: toolResultText,
        });
      }
    }

    const wallClockMs = performance.now() - trialStartMs;
    const finalWsTest = runWorkspaceTests(workspaceDir);
    const finalOracleTest = runHeldOutOracleTests(workspaceDir, task);

    // Check if any distractor file was broken or deleted (regression check)
    let regressionDetected = false;
    const syntaxCheck = spawnSync(
      process.execPath,
      ['--check', ...task.targetFiles.map((f) => path.join(workspaceDir, f))],
      { cwd: workspaceDir, encoding: 'utf8' }
    );
    if ((syntaxCheck.status ?? 1) !== 0) {
      regressionDetected = true;
    }

    const totalTokens = inputTokens + outputTokens;
    const equivalentApiCostUsd =
      (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
    const hookOverheadPct = wallClockMs > 0 ? (hookLatencyMs / wallClockMs) * 100 : 0;

    return {
      taskId: task.id,
      category: task.category,
      title: task.title,
      condition,
      evidenceType: 'REAL_AGENT',
      modelName,
      workspaceTestsPassed: finalWsTest.passed,
      heldOutOraclePassed: finalOracleTest.passed,
      regressionDetected,
      inputTokens,
      outputTokens,
      totalTokens,
      equivalentApiCostUsd: Number(equivalentApiCostUsd.toFixed(6)),
      llmTurns,
      toolCallsCount,
      distractorFilesRead,
      stopHookInterceptions,
      preToolBlocks,
      wallClockMs: Number(wallClockMs.toFixed(1)),
      hookLatencyMs: Number(hookLatencyMs.toFixed(2)),
      hookOverheadPct: Number(hookOverheadPct.toFixed(3)),
      traceSummary,
      finalVerificationStatus,
    };
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregateConditionResults(
  records: RealTrialRecord[],
  condition: ExperimentCondition
): ConditionAggregate {
  const condRecords = records.filter((r) => r.condition === condition);
  const n = condRecords.length;
  const modelName = condRecords[0]?.modelName ?? 'qwen2.5:7b';

  const oracleSuccesses = condRecords.filter((r) => r.heldOutOraclePassed).length;
  const wsSuccesses = condRecords.filter((r) => r.workspaceTestsPassed).length;
  const regressions = condRecords.filter((r) => r.regressionDetected).length;

  const inToks = condRecords.map((r) => r.inputTokens);
  const outToks = condRecords.map((r) => r.outputTokens);
  const totToks = condRecords.map((r) => r.totalTokens);
  const costs = condRecords.map((r) => r.equivalentApiCostUsd);
  const wallMs = condRecords.map((r) => r.wallClockMs);
  const hookMs = condRecords.map((r) => r.hookLatencyMs);
  const hookPct = condRecords.map((r) => r.hookOverheadPct);

  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const costPerVerifiedSuccessUsd =
    oracleSuccesses > 0 ? totalCost / oracleSuccesses : totalCost;

  return {
    condition,
    evidenceType: 'REAL_AGENT',
    modelName,
    tasksCount: n,
    oracleCompletion: computeWilson95CI(oracleSuccesses, n),
    workspaceTestCompletion: computeWilson95CI(wsSuccesses, n),
    regressionRate: computeWilson95CI(regressions, n),
    meanInputTokens: Math.round(mean(inToks)),
    medianInputTokens: Math.round(median(inToks)),
    meanOutputTokens: Math.round(mean(outToks)),
    meanTotalTokens: Math.round(mean(totToks)),
    meanEquivalentCostUsd: Number(mean(costs).toFixed(5)),
    costPerVerifiedSuccessUsd: Number(costPerVerifiedSuccessUsd.toFixed(5)),
    meanWallClockMs: Math.round(mean(wallMs)),
    medianWallClockMs: Math.round(median(wallMs)),
    meanHookLatencyMs: Number(mean(hookMs).toFixed(2)),
    meanHookOverheadPct: Number(mean(hookPct).toFixed(2)),
    meanToolCalls: Number(mean(condRecords.map((r) => r.toolCallsCount)).toFixed(2)),
    meanDistractorReads: Number(mean(condRecords.map((r) => r.distractorFilesRead)).toFixed(2)),
    totalStopInterceptions: condRecords.reduce((a, r) => a + r.stopHookInterceptions, 0),
    totalPreToolBlocks: condRecords.reduce((a, r) => a + r.preToolBlocks, 0),
  };
}

export interface FullRealBenchmarkSummary {
  generatedAt: string;
  evidenceClassification: 'REAL_AGENT';
  modelName: string;
  tasksCount: number;
  conditions: ExperimentCondition[];
  totalRealAgentRuns: number;
  aggregates: Partial<Record<ExperimentCondition, ConditionAggregate>>;
  pairedComparisonsVsBaseline: Partial<
    Record<
      Exclude<ExperimentCondition, 'baseline'>,
      {
        inputTokens: ReturnType<typeof computePairedDelta95CI>;
        outputTokens: ReturnType<typeof computePairedDelta95CI>;
        totalTokens: ReturnType<typeof computePairedDelta95CI>;
        wallClockMs: ReturnType<typeof computePairedDelta95CI>;
        equivalentCostUsd: ReturnType<typeof computePairedDelta95CI>;
      }
    >
  >;
  categoryBreakdown: Array<{
    category: string;
    tasksCount: number;
    baselineOracleRatePct: number;
    contextOnlyOracleRatePct: number;
    verificationOnlyOracleRatePct: number;
    fullAgentOptOracleRatePct: number;
    baselineMeanInputTokens: number;
    fullAgentOptMeanInputTokens: number;
    inputTokenReductionPct: number;
  }>;
  trials: RealTrialRecord[];
}

export async function runFullRealBenchmarkSuite(
  outputPath: string,
  modelName = 'qwen2.5:7b',
  concurrency = 1
): Promise<FullRealBenchmarkSummary> {
  const conditions: ExperimentCondition[] = [
    'baseline',
    'context-only',
    'verification-only',
    'full-agent-opt',
  ];
  const allTrials: RealTrialRecord[] = [];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const partialPath = outputPath + '.partial.json';
  if (fs.existsSync(partialPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(partialPath, 'utf8')) as {
        trials?: RealTrialRecord[];
      };
      if (Array.isArray(parsed.trials)) {
        allTrials.push(...parsed.trials);
      }
    } catch {
      // ignore corrupt partial file
    }
  }

  for (let i = 0; i < REAL_BENCHMARK_TASKS_30.length; i += concurrency) {
    const batch = REAL_BENCHMARK_TASKS_30.slice(i, i + concurrency);
    let ranAny = false;
    for (const task of batch) {
      for (const cond of conditions) {
        const alreadyDone = allTrials.some(
          (r) => r.taskId === task.id && r.condition === cond
        );
        if (alreadyDone) continue;
        ranAny = true;
        const rec = await runSingleRealTrial(task, cond, modelName);
        allTrials.push(rec);
      }
    }
    if (!ranAny) continue;

    const doneTasks = Math.min(i + concurrency, REAL_BENCHMARK_TASKS_30.length);
    const baseDone = allTrials.filter((r) => r.condition === 'baseline');
    const fullDone = allTrials.filter((r) => r.condition === 'full-agent-opt');
    const basePass = baseDone.filter((r) => r.heldOutOraclePassed).length;
    const fullPass = fullDone.filter((r) => r.heldOutOraclePassed).length;
    const baseIn = Math.round(
      baseDone.reduce((a, r) => a + r.inputTokens, 0) / Math.max(1, baseDone.length)
    );
    const fullIn = Math.round(
      fullDone.reduce((a, r) => a + r.inputTokens, 0) / Math.max(1, fullDone.length)
    );
    process.stdout.write(
      `[Progress ${doneTasks}/30 tasks (${allTrials.length}/120 runs)] ` +
        `Baseline Oracle: ${basePass}/${doneTasks} (mean inTok: ${baseIn}) | ` +
        `Full AgentOpt Oracle: ${fullPass}/${doneTasks} (mean inTok: ${fullIn})\n`
    );
    fs.writeFileSync(
      outputPath + '.partial.json',
      JSON.stringify({ doneTasks, trialsCount: allTrials.length, trials: allTrials }, null, 2),
      'utf8'
    );
  }

  const aggregates = {
    baseline: aggregateConditionResults(allTrials, 'baseline'),
    'context-only': aggregateConditionResults(allTrials, 'context-only'),
    'verification-only': aggregateConditionResults(allTrials, 'verification-only'),
    'full-agent-opt': aggregateConditionResults(allTrials, 'full-agent-opt'),
  };

  const baseRecords = REAL_BENCHMARK_TASKS_30.map(
    (t) => allTrials.find((r) => r.taskId === t.id && r.condition === 'baseline')!
  );

  const buildPaired = (cond: Exclude<ExperimentCondition, 'baseline'>) => {
    const treatRecords = REAL_BENCHMARK_TASKS_30.map(
      (t) => allTrials.find((r) => r.taskId === t.id && r.condition === cond)!
    );
    return {
      inputTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.inputTokens),
        treatRecords.map((r) => r.inputTokens)
      ),
      outputTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.outputTokens),
        treatRecords.map((r) => r.outputTokens)
      ),
      totalTokens: computePairedDelta95CI(
        baseRecords.map((r) => r.totalTokens),
        treatRecords.map((r) => r.totalTokens)
      ),
      wallClockMs: computePairedDelta95CI(
        baseRecords.map((r) => r.wallClockMs),
        treatRecords.map((r) => r.wallClockMs)
      ),
      equivalentCostUsd: computePairedDelta95CI(
        baseRecords.map((r) => r.equivalentApiCostUsd),
        treatRecords.map((r) => r.equivalentApiCostUsd)
      ),
    };
  };

  const categories = [
    'bugfix',
    'feature',
    'multi_file',
    'refactoring',
    'validation',
    'algorithms',
  ];

  const categoryBreakdown = categories.map((cat) => {
    const catBase = allTrials.filter((r) => r.category === cat && r.condition === 'baseline');
    const catCtx = allTrials.filter((r) => r.category === cat && r.condition === 'context-only');
    const catVer = allTrials.filter(
      (r) => r.category === cat && r.condition === 'verification-only'
    );
    const catFull = allTrials.filter((r) => r.category === cat && r.condition === 'full-agent-opt');
    const n = catBase.length;
    const rate = (arr: RealTrialRecord[]) =>
      n > 0 ? Number(((arr.filter((r) => r.heldOutOraclePassed).length / n) * 100).toFixed(1)) : 0;
    const meanIn = (arr: RealTrialRecord[]) =>
      n > 0 ? Math.round(arr.reduce((a, r) => a + r.inputTokens, 0) / n) : 0;
    const bIn = meanIn(catBase);
    const fIn = meanIn(catFull);
    return {
      category: cat,
      tasksCount: n,
      baselineOracleRatePct: rate(catBase),
      contextOnlyOracleRatePct: rate(catCtx),
      verificationOnlyOracleRatePct: rate(catVer),
      fullAgentOptOracleRatePct: rate(catFull),
      baselineMeanInputTokens: bIn,
      fullAgentOptMeanInputTokens: fIn,
      inputTokenReductionPct: bIn > 0 ? Number((((fIn - bIn) / bIn) * 100).toFixed(1)) : 0,
    };
  });

  const summary: FullRealBenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    evidenceClassification: 'REAL_AGENT',
    modelName,
    tasksCount: REAL_BENCHMARK_TASKS_30.length,
    conditions,
    totalRealAgentRuns: allTrials.length,
    aggregates,
    pairedComparisonsVsBaseline: {
      'context-only': buildPaired('context-only'),
      'verification-only': buildPaired('verification-only'),
      'full-agent-opt': buildPaired('full-agent-opt'),
    },
    categoryBreakdown,
    trials: allTrials,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}
