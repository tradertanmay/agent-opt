import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  HookLifecycleEvent,
  NormalizedHookEvent,
  OptimizationDecision,
  SupportedPlatform,
} from '../types/index.js';
import { AgentOptimizerCore } from '../core/optimizer.js';

export interface PlatformAdapterOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Normalizes incoming stdin JSON payloads from Claude Code, Google Antigravity, Cursor, or OpenAI Codex
 * into a unified NormalizedHookEvent.
 */
export function parsePlatformHookPayload(
  rawPayload: Record<string, unknown>,
  explicitPlatform?: SupportedPlatform,
  explicitEvent?: HookLifecycleEvent,
  fallbackCwd: string = process.cwd()
): NormalizedHookEvent {
  const platform = explicitPlatform || detectPlatformFromPayload(rawPayload);
  const now = new Date().toISOString();

  if (platform === 'google-antigravity') {
    const sessionId =
      (rawPayload.conversationId as string) ||
      (rawPayload.sessionId as string) ||
      (rawPayload.session_id as string) ||
      'agy-session';
    const workspacePaths = rawPayload.workspacePaths as string[] | undefined;
    const cwd =
      (workspacePaths && workspacePaths[0]) ||
      (rawPayload.cwd as string) ||
      fallbackCwd;
    const toolCall = rawPayload.toolCall as
      | { name?: string; args?: Record<string, unknown> }
      | undefined;

    let event: HookLifecycleEvent = explicitEvent || 'PreToolUse';
    if (!explicitEvent) {
      if (rawPayload.terminationReason !== undefined) {
        event = 'Stop';
      } else if (rawPayload.invocationNum !== undefined) {
        event = 'PreInvocation';
      } else if (toolCall !== undefined) {
        event = 'PreToolUse';
      } else if (rawPayload.stepIdx !== undefined) {
        event = 'PostToolUse';
      }
    }

    const explicitExitCode =
      typeof rawPayload.exitCode === 'number'
        ? rawPayload.exitCode
        : typeof rawPayload.exit_code === 'number'
        ? rawPayload.exit_code
        : rawPayload.error
        ? 1
        : 0;

    return {
      platform: 'google-antigravity',
      sessionId,
      event,
      timestamp: now,
      cwd,
      userPrompt:
        (rawPayload.userPrompt as string) ||
        (rawPayload.prompt as string) ||
        (rawPayload.user_prompt as string),
      toolName:
        toolCall?.name ||
        (rawPayload.toolName as string) ||
        (rawPayload.tool_name as string),
      toolInput:
        toolCall?.args ||
        (rawPayload.toolInput as Record<string, unknown>) ||
        (rawPayload.tool_input as Record<string, unknown>),
      toolOutput:
        (rawPayload.toolOutput as string | Record<string, unknown> | undefined) ||
        (rawPayload.tool_response as string | Record<string, unknown> | undefined),
      toolError: (rawPayload.error as string) || undefined,
      exitCode: explicitExitCode,
      rawPayload,
    };
  }

  if (platform === 'cursor') {
    const sessionId =
      (rawPayload.conversation_id as string) ||
      (rawPayload.generation_id as string) ||
      'cursor-session';
    const workspaceRoots = rawPayload.workspace_roots as string[] | undefined;
    const cwd =
      (workspaceRoots && workspaceRoots[0]) ||
      (rawPayload.cwd as string) ||
      fallbackCwd;
    const rawEventName =
      (rawPayload.hook_event_name as string) || explicitEvent || 'PreToolUse';

    const eventMap: Record<string, HookLifecycleEvent> = {
      sessionStart: 'SessionStart',
      beforeSubmitPrompt: 'UserPromptSubmit',
      preToolUse: 'PreToolUse',
      beforeShellExecution: 'PreToolUse',
      beforeReadFile: 'PreToolUse',
      postToolUse: 'PostToolUse',
      afterShellExecution: 'PostToolUse',
      afterFileEdit: 'PostToolUse',
      stop: 'Stop',
      sessionEnd: 'SessionEnd',
    };
    const event = eventMap[rawEventName] || explicitEvent || 'PostToolUse';

    let toolName = (rawPayload.tool_name as string) || rawEventName;
    const toolInput: Record<string, unknown> =
      (rawPayload.tool_input as Record<string, unknown>) || {};
    if (rawPayload.file_path) toolInput.file_path = rawPayload.file_path;
    if (rawPayload.command) {
      toolInput.command = rawPayload.command;
      toolName = 'Bash';
    }
    if (rawEventName === 'afterFileEdit') {
      toolName = 'Edit';
    }
    if (rawEventName === 'beforeReadFile') {
      toolName = 'Read';
    }

    return {
      platform: 'cursor',
      sessionId,
      event,
      timestamp: now,
      cwd,
      userPrompt: (rawPayload.prompt as string) || (rawPayload.user_prompt as string),
      toolName,
      toolInput,
      toolOutput: (rawPayload.output as string) || (rawPayload.stdout as string),
      toolError: (rawPayload.error as string) || (rawPayload.stderr as string),
      exitCode:
        typeof rawPayload.exit_code === 'number' ? rawPayload.exit_code : undefined,
      rawPayload,
    };
  }

  // Claude Code & OpenAI Codex (both use session_id, hook_event_name, tool_name, tool_input, tool_response)
  const sessionId =
    (rawPayload.session_id as string) ||
    (rawPayload.sessionId as string) ||
    'agent-session';
  const cwd = (rawPayload.cwd as string) || fallbackCwd;
  const rawEventName =
    (rawPayload.hook_event_name as string) || explicitEvent || 'PreToolUse';

  const validEvents = new Set<HookLifecycleEvent>([
    'SessionStart',
    'UserPromptSubmit',
    'PreInvocation',
    'PreToolUse',
    'PostToolUse',
    'PostInvocation',
    'Stop',
    'SessionEnd',
  ]);
  const event: HookLifecycleEvent = validEvents.has(rawEventName as HookLifecycleEvent)
    ? (rawEventName as HookLifecycleEvent)
    : explicitEvent || 'PreToolUse';

  const toolResponse = rawPayload.tool_response as Record<string, unknown> | string | undefined;
  let exitCode: number | undefined =
    typeof rawPayload.exit_code === 'number' ? rawPayload.exit_code : undefined;
  let toolError = (rawPayload.error as string) || undefined;
  let toolOutput: Record<string, unknown> | string | undefined = toolResponse;

  if (toolResponse && typeof toolResponse === 'object') {
    if (typeof toolResponse.exitCode === 'number') {
      exitCode = toolResponse.exitCode;
    } else if (typeof toolResponse.exit_code === 'number') {
      exitCode = toolResponse.exit_code;
    }
    if (typeof toolResponse.stderr === 'string' && toolResponse.stderr.trim()) {
      toolError = toolResponse.stderr;
    }
    if (typeof toolResponse.stdout === 'string') {
      toolOutput = toolResponse.stdout;
    }
  }

  return {
    platform,
    sessionId,
    event,
    timestamp: now,
    cwd,
    userPrompt:
      (rawPayload.prompt as string) ||
      (rawPayload.user_prompt as string) ||
      undefined,
    toolName: (rawPayload.tool_name as string) || undefined,
    toolCallId: (rawPayload.tool_use_id as string) || undefined,
    toolInput: (rawPayload.tool_input as Record<string, unknown>) || undefined,
    toolOutput,
    toolError,
    exitCode,
    inputTokens:
      typeof rawPayload.input_tokens === 'number' ? rawPayload.input_tokens : undefined,
    outputTokens:
      typeof rawPayload.output_tokens === 'number' ? rawPayload.output_tokens : undefined,
    rawPayload,
  };
}

/**
 * Formats a provider-independent OptimizationDecision into the exact stdout/stderr/exitCode
 * contract required by each coding agent platform.
 */
export function formatPlatformHookOutput(
  platform: SupportedPlatform,
  event: HookLifecycleEvent,
  decision: OptimizationDecision
): PlatformAdapterOutput {
  if (platform === 'google-antigravity') {
    if (event === 'PreInvocation' || event === 'UserPromptSubmit' || event === 'SessionStart') {
      if (decision.injectedContext) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            injectSteps: [{ ephemeralMessage: decision.injectedContext }],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
    }

    if (event === 'PreToolUse') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: decision.action === 'block' ? 'deny' : 'allow',
          ...(decision.agentFeedback ? { reason: decision.agentFeedback } : {}),
          ...(decision.updatedToolInput ? { overwrite: decision.updatedToolInput } : {}),
        }),
        stderr: '',
      };
    }

    if (event === 'Stop') {
      if (decision.action === 'block') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: 'continue',
            reason:
              decision.agentFeedback ||
              'Task verification incomplete. Please verify changes before stopping.',
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'allow' }),
        stderr: '',
      };
    }

    // PostToolUse / PostInvocation in Antigravity
    return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
  }

  if (platform === 'cursor') {
    if (event === 'PreToolUse') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          permission: decision.action === 'block' ? 'deny' : 'allow',
          ...(decision.agentFeedback
            ? {
                user_message: decision.agentFeedback,
                agentMessage: decision.agentFeedback,
                agent_message: decision.agentFeedback,
              }
            : {}),
        }),
        stderr: '',
      };
    }
    if (event === 'Stop' && decision.action === 'block') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: 'block',
          reason: decision.agentFeedback,
          followup_message: decision.agentFeedback,
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        decision.injectedContext
          ? {
              agentMessage: decision.injectedContext,
              additional_context: decision.injectedContext,
            }
          : {}
      ),
      stderr: '',
    };
  }

  if (platform === 'openai-codex') {
    if (decision.action === 'block') {
      // Codex CLI uses exit code 2 to gate/block PreToolUse or Stop
      return {
        exitCode: 2,
        stdout: JSON.stringify({
          decision: 'block',
          reason: decision.agentFeedback,
        }),
        stderr: decision.agentFeedback || 'Blocked by AgentOpt policy.',
      };
    }
    if (
      decision.injectedContext &&
      (event === 'SessionStart' ||
        event === 'UserPromptSubmit' ||
        event === 'PreToolUse' ||
        event === 'PostToolUse')
    ) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            ...(event === 'PreToolUse' ? { permissionDecision: 'allow' } : {}),
            additionalContext: decision.injectedContext,
          },
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({}),
      stderr: '',
    };
  }

  // Default: Claude Code ('claude-code')
  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    if (decision.injectedContext) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: decision.injectedContext,
          },
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
  }

  if (event === 'PreToolUse') {
    if (decision.action === 'block') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              decision.agentFeedback || 'Blocked by AgentOpt optimizer.',
          },
        }),
        stderr: '',
      };
    }
    if (decision.injectedContext || decision.updatedToolInput) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            ...(decision.injectedContext
              ? { additionalContext: decision.injectedContext }
              : {}),
            ...(decision.updatedToolInput
              ? { updatedInput: decision.updatedToolInput }
              : {}),
          },
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
  }

  if (event === 'PostToolUse') {
    if (decision.action === 'block' && decision.agentFeedback) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: 'block',
          reason: decision.agentFeedback,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: decision.agentFeedback,
          },
        }),
        stderr: '',
      };
    }
    if (decision.injectedContext) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: decision.injectedContext,
          },
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
  }

  if (event === 'Stop') {
    if (decision.action === 'block') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: 'block',
          reason:
            decision.agentFeedback ||
            'Verification required before completing task.',
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
  }

  return { exitCode: 0, stdout: JSON.stringify({}), stderr: '' };
}

export function detectPlatformFromPayload(
  raw: Record<string, unknown>
): SupportedPlatform {
  if (
    raw.conversationId !== undefined ||
    raw.workspacePaths !== undefined ||
    raw.toolCall !== undefined ||
    raw.invocationNum !== undefined
  ) {
    return 'google-antigravity';
  }
  if (
    raw.conversation_id !== undefined ||
    raw.workspace_roots !== undefined ||
    raw.generation_id !== undefined
  ) {
    return 'cursor';
  }
  if (raw.codex_session !== undefined) {
    return 'openai-codex';
  }
  return 'claude-code';
}

export interface DetectedAgentInfo {
  platform: SupportedPlatform;
  displayName: string;
  detected: boolean;
  installedInWorkspace: boolean;
  reasons: string[];
  validationTier: 'primary-verified' | 'experimental-schema-verified';
}

export interface PlatformVerificationCheck {
  platform: SupportedPlatform;
  installed: boolean;
  filesValid: boolean;
  hookExecutionPassed: boolean;
  checkedFiles: string[];
  details: string;
}

function hasBinaryInPath(binName: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [binName], { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

export function isPlatformInstalledInWorkspace(
  cwd: string,
  platform: SupportedPlatform
): boolean {
  if (platform === 'google-antigravity') {
    return (
      fs.existsSync(path.join(cwd, '.agents', 'plugins', 'agent-opt', 'plugin.json')) &&
      fs.existsSync(path.join(cwd, '.agents', 'plugins', 'agent-opt', 'hooks.json'))
    );
  }
  if (platform === 'claude-code') {
    const p = path.join(cwd, '.claude', 'settings.json');
    if (!fs.existsSync(p)) return false;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return content.includes('agent-opt') || content.includes('aopt');
    } catch {
      return false;
    }
  }
  if (platform === 'cursor') {
    const p = path.join(cwd, '.cursor', 'hooks.json');
    if (!fs.existsSync(p)) return false;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return content.includes('agent-opt') || content.includes('aopt');
    } catch {
      return false;
    }
  }
  if (platform === 'openai-codex') {
    const p = path.join(cwd, '.codex', 'hooks.json');
    if (!fs.existsSync(p)) return false;
    try {
      const content = fs.readFileSync(p, 'utf-8');
      return content.includes('agent-opt') || content.includes('aopt');
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Detects installed or active AI coding agents on the developer's machine and workspace.
 */
export function detectInstalledAgents(cwd: string): DetectedAgentInfo[] {
  const home = os.homedir();
  const results: DetectedAgentInfo[] = [];

  // 1. Google Antigravity
  const agyReasons: string[] = [];
  if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_CSRF_TOKEN) {
    agyReasons.push('Antigravity Language Server environment active');
  }
  if (fs.existsSync(path.join(home, '.gemini', 'antigravity'))) {
    agyReasons.push('~/.gemini/antigravity present');
  }
  if (fs.existsSync(path.join(cwd, '.agents'))) {
    agyReasons.push('.agents/ directory in workspace');
  }
  if (hasBinaryInPath('agy')) {
    agyReasons.push('agy CLI in PATH');
  }
  results.push({
    platform: 'google-antigravity',
    displayName: 'Google Antigravity 2.0',
    detected: agyReasons.length > 0,
    installedInWorkspace: isPlatformInstalledInWorkspace(cwd, 'google-antigravity'),
    reasons: agyReasons,
    validationTier: 'primary-verified',
  });

  // 2. Claude Code
  const claudeReasons: string[] = [];
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_PROJECT_DIR) {
    claudeReasons.push('Claude Code environment active');
  }
  if (fs.existsSync(path.join(home, '.claude'))) {
    claudeReasons.push('~/.claude directory present');
  }
  if (fs.existsSync(path.join(cwd, '.claude'))) {
    claudeReasons.push('.claude/ directory in workspace');
  }
  if (hasBinaryInPath('claude')) {
    claudeReasons.push('claude CLI in PATH');
  }
  results.push({
    platform: 'claude-code',
    displayName: 'Claude Code',
    detected: claudeReasons.length > 0,
    installedInWorkspace: isPlatformInstalledInWorkspace(cwd, 'claude-code'),
    reasons: claudeReasons,
    validationTier: hasBinaryInPath('claude')
      ? 'primary-verified'
      : 'experimental-schema-verified',
  });

  // 3. OpenAI Codex
  const codexReasons: string[] = [];
  if (process.env.CODEX_HOME) {
    codexReasons.push('CODEX_HOME environment active');
  }
  if (fs.existsSync(path.join(home, '.codex'))) {
    codexReasons.push('~/.codex directory present');
  }
  if (fs.existsSync(path.join(cwd, '.codex'))) {
    codexReasons.push('.codex/ directory in workspace');
  }
  if (hasBinaryInPath('codex')) {
    codexReasons.push('codex CLI in PATH');
  }
  results.push({
    platform: 'openai-codex',
    displayName: 'OpenAI Codex CLI',
    detected: codexReasons.length > 0,
    installedInWorkspace: isPlatformInstalledInWorkspace(cwd, 'openai-codex'),
    reasons: codexReasons,
    validationTier: hasBinaryInPath('codex')
      ? 'primary-verified'
      : 'experimental-schema-verified',
  });

  // 4. Cursor
  const cursorReasons: string[] = [];
  if (process.env.CURSOR_TRACE_ID) {
    cursorReasons.push('Cursor IDE environment active');
  }
  if (fs.existsSync(path.join(home, '.cursor'))) {
    cursorReasons.push('~/.cursor directory present');
  }
  if (fs.existsSync(path.join(cwd, '.cursor'))) {
    cursorReasons.push('.cursor/ directory in workspace');
  }
  if (hasBinaryInPath('cursor')) {
    cursorReasons.push('cursor CLI in PATH');
  }
  if (hasBinaryInPath('cursor-agent')) {
    cursorReasons.push('cursor-agent CLI in PATH');
  }
  if (fs.existsSync('/Applications/Cursor.app')) {
    cursorReasons.push('/Applications/Cursor.app installed');
  }
  results.push({
    platform: 'cursor',
    displayName: 'Cursor',
    detected: cursorReasons.length > 0,
    installedInWorkspace: isPlatformInstalledInWorkspace(cwd, 'cursor'),
    reasons: cursorReasons,
    validationTier:
      hasBinaryInPath('cursor-agent') || hasBinaryInPath('cursor')
        ? 'primary-verified'
        : 'experimental-schema-verified',
  });

  return results;
}

function mergeMcpJsonFile(mcpPath: string): void {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }
  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  servers['agent-opt'] = {
    command: 'npx',
    args: ['agent-opt', 'mcp'],
  };
  existing.mcpServers = servers;
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
}

function unmergeMcpJsonFile(mcpPath: string): boolean {
  if (!fs.existsSync(mcpPath)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    if (!existing || typeof existing !== 'object') return false;
    const servers = existing.mcpServers as Record<string, unknown> | undefined;
    if (servers && typeof servers === 'object' && 'agent-opt' in servers) {
      delete servers['agent-opt'];
      if (Object.keys(servers).length === 0) {
        delete existing.mcpServers;
      }
      if (Object.keys(existing).length === 0) {
        fs.rmSync(mcpPath, { force: true });
      } else {
        fs.writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
      }
      return true;
    }
  } catch {
    // Ignore malformed JSON
  }
  return false;
}

/**
 * Installs non-destructive platform hook configurations for Claude Code, Google Antigravity, Cursor, and OpenAI Codex.
 */
export function installPlatformAdapter(
  cwd: string,
  platform: SupportedPlatform,
  cliCommand = 'npx agent-opt'
): { installedFiles: string[] } {
  const installedFiles: string[] = [];

  if (platform === 'claude-code') {
    const claudeDir = path.join(cwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }

    const hooks = (existing.hooks as Record<string, unknown[]>) || {};
    const hookEvents: HookLifecycleEvent[] = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ];

    for (const ev of hookEvents) {
      const cmd = `${cliCommand} hook --platform claude-code --event ${ev}`;
      const list = Array.isArray(hooks[ev]) ? [...hooks[ev]] : [];
      // Remove any prior agent-opt entries before adding fresh one
      const filtered = list.filter(
        (item) =>
          !JSON.stringify(item).includes('agent-opt') &&
          !JSON.stringify(item).includes('aopt')
      );
      if (ev === 'PreToolUse' || ev === 'PostToolUse') {
        filtered.push({
          matcher: '*',
          hooks: [{ type: 'command', command: cmd, timeout: 10 }],
        });
      } else {
        filtered.push({
          hooks: [{ type: 'command', command: cmd, timeout: 10 }],
        });
      }
      hooks[ev] = filtered;
    }

    existing.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    installedFiles.push(settingsPath);

    const mcpPath = path.join(cwd, '.mcp.json');
    mergeMcpJsonFile(mcpPath);
    installedFiles.push(mcpPath);
  }

  if (platform === 'google-antigravity') {
    const pluginDir = path.join(cwd, '.agents', 'plugins', 'agent-opt');
    const rulesDir = path.join(pluginDir, 'rules');
    const skillsDir = path.join(pluginDir, 'skills', 'agent-opt');
    const assetsDir = path.join(pluginDir, 'assets');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });

    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    fs.writeFileSync(
      pluginJsonPath,
      JSON.stringify(
        {
          name: 'agent-opt',
          displayName: 'AgentOpt',
          version: '0.1.0',
          description:
            'Make your AI coding agent smarter, faster, and more token-efficient with AST context ranking, duplicate-operation prevention, and optional task verification.',
          logo: 'assets/logo.svg',
          suggestedPrompts: [
            'Check AgentOpt optimization status and active mode in this repository',
            'Preview the ranked symbol context map for a bug fix or feature task',
            'Switch AgentOpt between FAST, BALANCED, and STRICT verification modes',
          ],
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    installedFiles.push(pluginJsonPath);

    const hooksJsonPath = path.join(pluginDir, 'hooks.json');
    const agyHooks = {
      'agent-opt': {
        enabled: true,
        PreInvocation: [
          {
            type: 'command',
            command: `${cliCommand} hook --platform google-antigravity --event PreInvocation`,
            timeout: 10,
          },
        ],
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `${cliCommand} hook --platform google-antigravity --event PreToolUse`,
                timeout: 10,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: `${cliCommand} hook --platform google-antigravity --event PostToolUse`,
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            type: 'command',
            command: `${cliCommand} hook --platform google-antigravity --event Stop`,
            timeout: 10,
          },
        ],
      },
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify(agyHooks, null, 2) + '\n', 'utf-8');
    installedFiles.push(hooksJsonPath);

    const mcpConfigPath = path.join(pluginDir, 'mcp_config.json');
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            'agent-opt': {
              command: 'npx',
              args: ['agent-opt', 'mcp'],
            },
          },
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    installedFiles.push(mcpConfigPath);

    const agentsMdPath = path.join(rulesDir, 'AGENTS.md');
    fs.writeFileSync(
      agentsMdPath,
      [
        '# AgentOpt Optimization Rules',
        '',
        '- Prefer reading targeted line slices (`StartLine`/`EndLine` or `offset`/`limit`) suggested by `[AgentOpt Context Map]` over reading entire large files.',
        '- Do not re-read unchanged files that are already in your current session context.',
        '- When modifying recursive functions or state constants, verify variable names and recursive calls before writing.',
      ].join('\n') + '\n',
      'utf-8'
    );
    installedFiles.push(agentsMdPath);

    const skillMdPath = path.join(skillsDir, 'SKILL.md');
    fs.writeFileSync(
      skillMdPath,
      [
        '---',
        'name: agent-opt',
        'description: Inspect and control the AgentOpt optimization layer (FAST, BALANCED, STRICT modes, ranked AST context maps, verification status, and session telemetry).',
        '---',
        '',
        '# AgentOpt Skill Guide',
        '',
        'Use the `aopt` / `npx agent-opt` CLI to inspect or configure AgentOpt in the current workspace:',
        '',
        '- `npx agent-opt status` — View active mode (`FAST` default, `BALANCED`, `STRICT`), indexed files, installed platforms, and token savings.',
        '- `npx agent-opt mode <FAST|BALANCED|STRICT>` — Switch optimization mode while preserving custom settings.',
        '- `npx agent-opt context "<task prompt>"` — Preview the ranked symbol & dependency context map for a task.',
        '- `npx agent-opt doctor` — Validate hook configurations, manifest health, and repository index.',
      ].join('\n') + '\n',
      'utf-8'
    );
    installedFiles.push(skillMdPath);

    const logoSvgPath = path.join(assetsDir, 'logo.svg');
    fs.writeFileSync(
      logoSvgPath,
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">',
        '  <rect x="14" y="14" width="100" height="100" rx="22" fill="#0F172A" stroke="#38BDF8" stroke-width="6"/>',
        '  <path d="M40 78 L58 42 L76 78 M46 66 H70" stroke="#38BDF8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        '  <circle cx="88" cy="52" r="10" fill="#22C55E"/>',
        '</svg>',
      ].join('\n') + '\n',
      'utf-8'
    );
    installedFiles.push(logoSvgPath);

    const bundleReadmePath = path.join(pluginDir, 'README.md');
    fs.writeFileSync(
      bundleReadmePath,
      [
        '# AgentOpt Plugin Bundle for Google Antigravity',
        '',
        'AgentOpt makes your AI coding agent smarter, faster, and more token-efficient.',
        '',
        '- **Default Mode:** `FAST` (AST context ranking + redundant read/write prevention + loop detection)',
        '- **Optional Modes:** `BALANCED` (silent in-hook verification probe) | `STRICT` (procedural test gate)',
        '- **CLI Control:** `npx agent-opt status`, `npx agent-opt mode BALANCED`, `npx agent-opt doctor`',
      ].join('\n') + '\n',
      'utf-8'
    );
    installedFiles.push(bundleReadmePath);
  }

  if (platform === 'cursor') {
    const cursorDir = path.join(cwd, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, 'hooks.json');
    let existing: Record<string, unknown> = { version: 1, hooks: {} };
    if (fs.existsSync(hooksPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        existing = { version: 1, hooks: {} };
      }
    }
    if (typeof existing.version !== 'number') {
      existing.version = 1;
    }
    const hooksObj =
      existing.hooks && typeof existing.hooks === 'object'
        ? { ...(existing.hooks as Record<string, unknown[]>) }
        : {};

    const cursorEventMap: Array<{ key: string; event: HookLifecycleEvent }> = [
      { key: 'sessionStart', event: 'SessionStart' },
      { key: 'beforeSubmitPrompt', event: 'UserPromptSubmit' },
      { key: 'beforeReadFile', event: 'PreToolUse' },
      { key: 'beforeShellExecution', event: 'PreToolUse' },
      { key: 'afterShellExecution', event: 'PostToolUse' },
      { key: 'afterFileEdit', event: 'PostToolUse' },
      { key: 'stop', event: 'Stop' },
    ];

    for (const { key, event } of cursorEventMap) {
      const list = Array.isArray(hooksObj[key]) ? [...hooksObj[key]] : [];
      const filtered = list.filter(
        (item) =>
          !JSON.stringify(item).includes('agent-opt') &&
          !JSON.stringify(item).includes('aopt')
      );
      filtered.push({
        command: `${cliCommand} hook --platform cursor --event ${event}`,
      });
      hooksObj[key] = filtered;
    }

    existing.hooks = hooksObj;
    fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    installedFiles.push(hooksPath);

    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    mergeMcpJsonFile(cursorMcpPath);
    installedFiles.push(cursorMcpPath);
  }

  if (platform === 'openai-codex') {
    const codexDir = path.join(cwd, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    // 1. Non-destructively merge .codex/hooks.json (Codex v0.163+ uses top-level "hooks" wrapper)
    const hooksJsonPath = path.join(codexDir, 'hooks.json');
    let existingRoot: Record<string, unknown> = {};
    if (fs.existsSync(hooksJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          existingRoot = parsed as Record<string, unknown>;
        }
      } catch {
        existingRoot = {};
      }
    }

    const hooksMap: Record<string, unknown[]> =
      existingRoot.hooks && typeof existingRoot.hooks === 'object'
        ? { ...(existingRoot.hooks as Record<string, unknown[]>) }
        : {};

    const codexEvents: HookLifecycleEvent[] = [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ];
    for (const ev of codexEvents) {
      const cmd = `${cliCommand} hook --platform openai-codex --event ${ev}`;
      // Preserve pre-existing user hooks from either hooksMap[ev] or legacy root existingRoot[ev]
      const priorNested = Array.isArray(hooksMap[ev]) ? [...hooksMap[ev]] : [];
      const priorLegacyRoot = Array.isArray(existingRoot[ev])
        ? [...(existingRoot[ev] as unknown[])]
        : [];
      delete existingRoot[ev];

      const combined = [...priorNested, ...priorLegacyRoot].filter(
        (item) =>
          !JSON.stringify(item).includes('agent-opt') &&
          !JSON.stringify(item).includes('aopt')
      );

      if (ev === 'PreToolUse' || ev === 'PostToolUse') {
        combined.push({
          matcher: '.*',
          hooks: [{ type: 'command', command: cmd }],
        });
      } else {
        combined.push({
          hooks: [{ type: 'command', command: cmd }],
        });
      }
      hooksMap[ev] = combined;
    }

    existingRoot.hooks = hooksMap;
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify(existingRoot, null, 2) + '\n',
      'utf-8'
    );
    installedFiles.push(hooksJsonPath);

    // 2. Non-destructively update .codex/config.toml enabling hooks = true while preserving user TOML
    const tomlPath = path.join(codexDir, 'config.toml');
    const markerStart = '# BEGIN AGENT-OPT';
    const markerEnd = '# END AGENT-OPT';
    let existingToml = '';
    if (fs.existsSync(tomlPath)) {
      try {
        existingToml = fs.readFileSync(tomlPath, 'utf-8');
      } catch {
        existingToml = '';
      }
    }
    const blockRegex = new RegExp(
      `${markerStart}[\\s\\S]*?${markerEnd}\\n?`,
      'g'
    );
    const cleanedToml = existingToml.replace(blockRegex, '').trimEnd();
    const hasFeaturesSection = /^\s*\[features\]\s*$/m.test(cleanedToml);
    const agentOptBlock = hasFeaturesSection
      ? [
          markerStart,
          '# AgentOpt Hooks Configuration for OpenAI Codex CLI (legacy: codex_hooks = true)',
          'hooks = true',
          markerEnd,
        ].join('\n')
      : [
          markerStart,
          '# AgentOpt Hooks Configuration for OpenAI Codex CLI (legacy: codex_hooks = true)',
          '[features]',
          'hooks = true',
          markerEnd,
        ].join('\n');

    const finalToml = cleanedToml
      ? `${cleanedToml}\n\n${agentOptBlock}\n`
      : `${agentOptBlock}\n`;
    fs.writeFileSync(tomlPath, finalToml, 'utf-8');
    installedFiles.push(tomlPath);
  }

  return { installedFiles };
}

/**
 * Cleanly removes AgentOpt hooks and plugin files for the specified platform while preserving user settings.
 */
export function uninstallPlatformAdapter(
  cwd: string,
  platform: SupportedPlatform
): { removedOrUpdatedFiles: string[] } {
  const removedOrUpdatedFiles: string[] = [];

  if (platform === 'claude-code') {
    const settingsPath = path.join(cwd, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        const hooks = existing.hooks as Record<string, unknown[]> | undefined;
        if (hooks) {
          for (const key of Object.keys(hooks)) {
            if (Array.isArray(hooks[key])) {
              hooks[key] = hooks[key].filter(
                (item) =>
                  !JSON.stringify(item).includes('agent-opt') &&
                  !JSON.stringify(item).includes('aopt')
              );
              if (hooks[key].length === 0) {
                delete hooks[key];
              }
            }
          }
          if (Object.keys(hooks).length === 0) {
            delete existing.hooks;
          }
        }
        if (Object.keys(existing).length === 0) {
          fs.rmSync(settingsPath, { force: true });
        } else {
          fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        }
        removedOrUpdatedFiles.push(settingsPath);
      } catch {
        // Ignore
      }
    }
    const mcpPath = path.join(cwd, '.mcp.json');
    if (unmergeMcpJsonFile(mcpPath)) {
      removedOrUpdatedFiles.push(mcpPath);
    }
  }

  if (platform === 'google-antigravity') {
    const pluginDir = path.join(cwd, '.agents', 'plugins', 'agent-opt');
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      removedOrUpdatedFiles.push(pluginDir);
    }
  }

  if (platform === 'cursor') {
    const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
    if (fs.existsSync(hooksPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        const hooksObj = existing.hooks as Record<string, unknown[]> | undefined;
        if (hooksObj && typeof hooksObj === 'object') {
          for (const key of Object.keys(hooksObj)) {
            if (Array.isArray(hooksObj[key])) {
              hooksObj[key] = hooksObj[key].filter(
                (item) =>
                  !JSON.stringify(item).includes('agent-opt') &&
                  !JSON.stringify(item).includes('aopt')
              );
              if (hooksObj[key].length === 0) {
                delete hooksObj[key];
              }
            }
          }
          if (Object.keys(hooksObj).length === 0) {
            delete existing.hooks;
          }
        }
        const remainingKeys = Object.keys(existing).filter((k) => k !== 'version');
        if (remainingKeys.length === 0) {
          fs.rmSync(hooksPath, { force: true });
        } else {
          fs.writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        }
      } catch {
        fs.rmSync(hooksPath, { force: true });
      }
      removedOrUpdatedFiles.push(hooksPath);
    }
    const cursorMcpPath = path.join(cwd, '.cursor', 'mcp.json');
    if (unmergeMcpJsonFile(cursorMcpPath)) {
      removedOrUpdatedFiles.push(cursorMcpPath);
    }
  }

  if (platform === 'openai-codex') {
    const hooksJsonPath = path.join(cwd, '.codex', 'hooks.json');
    if (fs.existsSync(hooksJsonPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        if (existing.hooks && typeof existing.hooks === 'object') {
          const hooksObj = existing.hooks as Record<string, unknown[]>;
          for (const key of Object.keys(hooksObj)) {
            if (Array.isArray(hooksObj[key])) {
              hooksObj[key] = hooksObj[key].filter(
                (item) =>
                  !JSON.stringify(item).includes('agent-opt') &&
                  !JSON.stringify(item).includes('aopt')
              );
              if (hooksObj[key].length === 0) {
                delete hooksObj[key];
              }
            }
          }
          if (Object.keys(hooksObj).length === 0) {
            delete existing.hooks;
          }
        }
        for (const key of Object.keys(existing)) {
          if (Array.isArray(existing[key])) {
            existing[key] = (existing[key] as unknown[]).filter(
              (item) =>
                !JSON.stringify(item).includes('agent-opt') &&
                !JSON.stringify(item).includes('aopt')
            );
            if ((existing[key] as unknown[]).length === 0) {
              delete existing[key];
            }
          }
        }
        if (Object.keys(existing).length === 0) {
          fs.rmSync(hooksJsonPath, { force: true });
        } else {
          fs.writeFileSync(hooksJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
        }
      } catch {
        fs.rmSync(hooksJsonPath, { force: true });
      }
      removedOrUpdatedFiles.push(hooksJsonPath);
    }

    const tomlPath = path.join(cwd, '.codex', 'config.toml');
    if (fs.existsSync(tomlPath)) {
      try {
        const raw = fs.readFileSync(tomlPath, 'utf-8');
        const cleaned = raw
          .replace(/# BEGIN AGENT-OPT[\s\S]*?# END AGENT-OPT\n?/g, '')
          .trim();
        if (!cleaned) {
          fs.rmSync(tomlPath, { force: true });
        } else {
          fs.writeFileSync(tomlPath, cleaned + '\n', 'utf-8');
        }
      } catch {
        fs.rmSync(tomlPath, { force: true });
      }
      removedOrUpdatedFiles.push(tomlPath);
    }
  }

  return { removedOrUpdatedFiles };
}

/**
 * Validates that a platform's manifests/configs are installed, well-formed, and that
 * its lifecycle hooks execute cleanly through the AgentOpt core.
 */
export function verifyPlatformInstallation(
  cwd: string,
  platform: SupportedPlatform
): PlatformVerificationCheck {
  const checkedFiles: string[] = [];
  let filesValid = true;
  const installed = isPlatformInstalledInWorkspace(cwd, platform);

  if (!installed) {
    return {
      platform,
      installed: false,
      filesValid: false,
      hookExecutionPassed: false,
      checkedFiles: [],
      details: 'Not installed in workspace',
    };
  }

  try {
    if (platform === 'google-antigravity') {
      const pluginDir = path.join(cwd, '.agents', 'plugins', 'agent-opt');
      const required = [
        path.join(pluginDir, 'plugin.json'),
        path.join(pluginDir, 'hooks.json'),
        path.join(pluginDir, 'mcp_config.json'),
        path.join(pluginDir, 'rules', 'AGENTS.md'),
        path.join(pluginDir, 'skills', 'agent-opt', 'SKILL.md'),
        path.join(pluginDir, 'assets', 'logo.svg'),
      ];
      for (const f of required) {
        checkedFiles.push(f);
        if (!fs.existsSync(f)) {
          filesValid = false;
        } else if (f.endsWith('.json')) {
          JSON.parse(fs.readFileSync(f, 'utf-8'));
        }
      }
    } else if (platform === 'claude-code') {
      const settingsPath = path.join(cwd, '.claude', 'settings.json');
      const mcpPath = path.join(cwd, '.mcp.json');
      checkedFiles.push(settingsPath, mcpPath);
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!parsed.hooks || !parsed.hooks.PreToolUse) filesValid = false;
      if (fs.existsSync(mcpPath)) {
        JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      }
    } else if (platform === 'cursor') {
      const hooksPath = path.join(cwd, '.cursor', 'hooks.json');
      const mcpPath = path.join(cwd, '.cursor', 'mcp.json');
      checkedFiles.push(hooksPath, mcpPath);
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (!parsed.hooks || !parsed.hooks.beforeShellExecution) filesValid = false;
      if (fs.existsSync(mcpPath)) {
        JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      }
    } else if (platform === 'openai-codex') {
      const hooksPath = path.join(cwd, '.codex', 'hooks.json');
      const tomlPath = path.join(cwd, '.codex', 'config.toml');
      checkedFiles.push(hooksPath, tomlPath);
      const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      const hooksContainer = parsed.hooks || parsed;
      if (!hooksContainer.PreToolUse || !hooksContainer.Stop) filesValid = false;
      if (!fs.existsSync(tomlPath)) {
        filesValid = false;
      } else {
        const toml = fs.readFileSync(tomlPath, 'utf-8');
        if (!toml.includes('hooks = true') && !toml.includes('codex_hooks = true')) {
          filesValid = false;
        }
      }
    }
  } catch {
    filesValid = false;
  }

  // Execute a live smoke test of the platform hook pipeline
  let hookExecutionPassed = false;
  try {
    const core = new AgentOptimizerCore({ cwd });
    const smokeSessionId = `doctor_smoke_${platform}`;
    const startEvent: HookLifecycleEvent =
      platform === 'google-antigravity' ? 'PreInvocation' : 'UserPromptSubmit';
    const normalized = parsePlatformHookPayload(
      {
        sessionId: smokeSessionId,
        conversationId: smokeSessionId,
        conversation_id: smokeSessionId,
        session_id: smokeSessionId,
        cwd,
        prompt: 'Doctor smoke check',
      },
      platform,
      startEvent,
      cwd
    );
    const decision = core.handleEvent(normalized);
    const formatted = formatPlatformHookOutput(platform, startEvent, decision);
    JSON.parse(formatted.stdout);
    // Clean up temporary smoke session file
    const smokeFile = path.join(core.getSessionsDir(), `${smokeSessionId}.json`);
    if (fs.existsSync(smokeFile)) {
      fs.rmSync(smokeFile, { force: true });
    }
    hookExecutionPassed = formatted.exitCode === 0;
  } catch {
    hookExecutionPassed = false;
  }

  return {
    platform,
    installed,
    filesValid,
    hookExecutionPassed,
    checkedFiles,
    details:
      filesValid && hookExecutionPassed
        ? 'Manifests valid & hook smoke check passed'
        : 'Validation failed',
  };
}


