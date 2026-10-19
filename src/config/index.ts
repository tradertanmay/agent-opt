import * as fs from 'node:fs';
import * as path from 'node:path';
import { OptimizerConfig, OptimizerMode } from '../types/index.js';

export const DEFAULT_CONFIG: OptimizerConfig = {
  enabled: true,
  mode: 'FAST',
  context: {
    enabled: true,
    maxRankedFiles: 8,
    maxRepoMapTokens: 650,
    deduplicateReads: true,
    blockRedundantFullReadsAfter: 2,
    minQuerySpecificityForInjection: true,
  },
  verification: {
    enabled: false,
    enforceOnStop: false,
    autoRunFastTestsOnStop: false,
    maxStopBlocksPerSession: 0,
    requireTestsWhenCodeModified: true,
    exemptDocOnlyChanges: true,
  },
  failureDetection: {
    enabled: true,
    maxRepeatedCommandFailures: 2,
    maxIdenticalErrors: 2,
    maxRedundantReadsOfUnchangedFile: 2,
    detectEditOscillation: true,
  },
  memory: {
    enabled: true,
    maxEntries: 50,
    minConfidenceToInject: 0.7,
    autoPruneContradictions: true,
  },
};

/**
 * Builds a complete OptimizerConfig preset for the requested mode:
 * - FAST: Context optimization, redundant-read/write prevention, and lightweight loop detection (zero Stop blocks).
 * - BALANCED: FAST + evidence-based verification activated only when meaningful source changes or detected failures justify it.
 * - STRICT: Stronger procedural verification requiring explicit agent test execution and up to 2 Stop continuations.
 */
export function createConfigForMode(
  mode: OptimizerMode,
  overrides?: Partial<OptimizerConfig>
): OptimizerConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  base.mode = mode;

  if (mode === 'FAST') {
    base.context.enabled = true;
    base.failureDetection.enabled = true;
    base.verification.enabled = false;
    base.verification.enforceOnStop = false;
    base.verification.autoRunFastTestsOnStop = false;
    base.verification.maxStopBlocksPerSession = 0;
  } else if (mode === 'BALANCED') {
    base.context.enabled = true;
    base.failureDetection.enabled = true;
    base.verification.enabled = true;
    base.verification.enforceOnStop = true;
    base.verification.autoRunFastTestsOnStop = true;
    base.verification.maxStopBlocksPerSession = 2;
  } else if (mode === 'STRICT') {
    base.context.enabled = true;
    base.failureDetection.enabled = true;
    base.verification.enabled = true;
    base.verification.enforceOnStop = true;
    base.verification.autoRunFastTestsOnStop = false;
    base.verification.maxStopBlocksPerSession = 2;
  }

  if (!overrides) return base;
  return {
    enabled: overrides.enabled ?? base.enabled,
    mode: overrides.mode ?? base.mode,
    context: { ...base.context, ...(overrides.context ?? {}) },
    verification: { ...base.verification, ...(overrides.verification ?? {}) },
    failureDetection: { ...base.failureDetection, ...(overrides.failureDetection ?? {}) },
    memory: { ...base.memory, ...(overrides.memory ?? {}) },
  };
}

export function switchModePreservingCustomSettings(
  existing: OptimizerConfig,
  newMode: OptimizerMode
): OptimizerConfig {
  const modeTemplate = createConfigForMode(newMode);
  return {
    enabled: existing.enabled,
    mode: newMode,
    context: { ...modeTemplate.context, ...existing.context },
    verification: {
      ...existing.verification,
      enabled: modeTemplate.verification.enabled,
      enforceOnStop: modeTemplate.verification.enforceOnStop,
      autoRunFastTestsOnStop: modeTemplate.verification.autoRunFastTestsOnStop,
      maxStopBlocksPerSession: modeTemplate.verification.maxStopBlocksPerSession,
    },
    failureDetection: { ...modeTemplate.failureDetection, ...existing.failureDetection },
    memory: { ...modeTemplate.memory, ...existing.memory },
  };
}

export function getAgentOptDir(cwd: string): string {
  return path.join(cwd, '.agent-opt');
}

export function loadConfig(cwd: string): OptimizerConfig {
  const configPath = path.join(getAgentOptDir(cwd), 'config.json');
  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<OptimizerConfig>;
    if (!raw || typeof raw !== 'object') {
      return structuredClone(DEFAULT_CONFIG);
    }
    let mode: OptimizerMode = DEFAULT_CONFIG.mode ?? 'FAST';
    if (raw.mode === 'FAST' || raw.mode === 'BALANCED' || raw.mode === 'STRICT') {
      mode = raw.mode;
    } else if (raw.verification?.enabled === true) {
      // Backward compatibility for legacy v0.1.0 configs without an explicit `mode` field
      mode =
        raw.verification.autoRunFastTestsOnStop === false ? 'STRICT' : 'BALANCED';
    }
    return createConfigForMode(mode, raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(cwd: string, config: OptimizerConfig): string {
  const dir = getAgentOptDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, configPath);
  return configPath;
}


