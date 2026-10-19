/**
 * Universal AI Coding Agent Optimizer (AgentOpt)
 * Core Type Definitions
 */

export type SupportedPlatform =
  | 'claude-code'
  | 'openai-codex'
  | 'cursor'
  | 'google-antigravity'
  | 'generic';

export type HookLifecycleEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreInvocation'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostInvocation'
  | 'Stop'
  | 'SessionEnd';

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'NOT_VERIFIED';

export interface NormalizedHookEvent {
  platform: SupportedPlatform;
  sessionId: string;
  event: HookLifecycleEvent;
  timestamp: string;
  cwd: string;
  userPrompt?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown> | string;
  toolError?: string;
  exitCode?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  rawPayload?: Record<string, unknown>;
}

export interface OptimizationDecision {
  /** Whether to allow, block/deny, or continue the current lifecycle action */
  action: 'allow' | 'block' | 'continue';
  /** Concise feedback or reason sent back to the coding agent */
  agentFeedback?: string;
  /** Additional optimized context injected into the agent's prompt/turn */
  injectedContext?: string;
  /** Optional mutated tool arguments (when supported by platform PreToolUse) */
  updatedToolInput?: Record<string, unknown>;
  /** Diagnostics and telemetry for the decision */
  diagnostics: {
    contextTokensSaved: number;
    contextTokensInjected: number;
    deduplicatedRead: boolean;
    failurePatternDetected?: FailurePatternType;
    verificationStatus?: VerificationStatus;
    memoriesApplied: string[];
    latencyMs: number;
  };
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'method'
  | 'export';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  exported: boolean;
  signature: string;
}

export interface FileNode {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  lineCount: number;
  sha256: string;
  mtimeMs: number;
  language: string;
  imports: string[];
  importedBy: string[];
  symbols: CodeSymbol[];
  centralityScore: number;
}

export interface RankedContextItem {
  relativePath: string;
  score: number;
  reasons: string[];
  relevantSymbols: CodeSymbol[];
  suggestedLineRange?: { start: number; end: number };
  estimatedFullTokens: number;
  estimatedSliceTokens: number;
}

export interface ContextOptimizationResult {
  query: string;
  rankedFiles: RankedContextItem[];
  compactRepoMap: string;
  injectedTokenCount: number;
  fullRepoTokenCount: number;
  estimatedTokensSaved: number;
  skippedLowRelevanceQuery?: boolean;
}

export interface FileReadRecord {
  relativePath: string;
  sha256AtRead: string;
  readCount: number;
  consecutiveReads: number;
  firstReadStep: number;
  lastReadStep: number;
  lineRange?: { start: number; end: number };
  estimatedTokens: number;
}

export type EvidenceType =
  | 'test_execution'
  | 'build_execution'
  | 'typecheck_execution'
  | 'lint_execution'
  | 'reproduction_check'
  | 'requirement_symbol_check';

export interface VerificationEvidence {
  type: EvidenceType;
  command?: string;
  passed: boolean;
  exitCode?: number;
  timestamp: string;
  stepIndex: number;
  summary: string;
  coveredFiles?: string[];
}

export interface RequirementCheck {
  id: string;
  description: string;
  targetFile?: string;
  requiredSymbolOrPattern?: string;
  satisfied: boolean;
  details: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  summary: string;
  hasRunnableVerificationSuite: boolean;
  userOptedOut: boolean;
  modifiedSourceFiles: string[];
  modifiedDocOnlyFiles: string[];
  dirtyFilesSinceLastVerification: string[];
  evidences: VerificationEvidence[];
  requirementChecks: RequirementCheck[];
  missingEvidenceReasons: string[];
  recommendedCommands: string[];
  shouldBlockStop: boolean;
  stopBlockCount: number;
}

export type FailurePatternType =
  | 'REPEATED_COMMAND_FAILURE'
  | 'IDENTICAL_ERROR_LOOP'
  | 'UNPRODUCTIVE_READ_LOOP'
  | 'EDIT_OSCILLATION_LOOP'
  | 'MISSING_DEPENDENCY'
  | 'BROKEN_TOOL_CALL'
  | 'STALLED_PROGRESS';

export interface DetectedFailurePattern {
  type: FailurePatternType;
  severity: 'warning' | 'critical';
  occurrences: number;
  evidenceSummary: string;
  actionableFeedback: string;
  shouldInterruptTool: boolean;
}

export type MemoryCategory =
  | 'build_command'
  | 'test_command'
  | 'lint_command'
  | 'repo_structure'
  | 'dependency_constraint'
  | 'debugging_discovery';

export interface ProjectMemoryEntry {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  verifiedCount: number;
  contradictedCount: number;
  createdAt: string;
  lastVerifiedAt: string;
  sourceSessionId: string;
  evidenceCommand?: string;
  packageJsonHash?: string;
  invalidated?: boolean;
  invalidationReason?: string;
}

export interface SessionState {
  sessionId: string;
  platform: SupportedPlatform;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  stepCount: number;
  lastToolName?: string;
  lastToolTargetFile?: string;
  userOptedOutOfVerification?: boolean;
  workspaceBaselineHashes?: Record<string, string>;
  initialPrompt?: string;
  extractedRequirements: RequirementCheck[];
  fileReads: Record<string, FileReadRecord>;
  modifiedFiles: Record<
    string,
    {
      relativePath: string;
      editCount: number;
      firstModifiedStep: number;
      lastModifiedStep: number;
      sha256History: string[];
      currentSha256: string;
      hasSubstantiveCodeChange?: boolean;
    }
  >;
  commandHistory: Array<{
    stepIndex: number;
    command: string;
    normalizedCommand: string;
    exitCode: number;
    errorSignature?: string;
    timestamp: string;
    isVerificationCmd: boolean;
  }>;
  toolErrorHistory: Array<{
    stepIndex: number;
    toolName: string;
    errorSignature: string;
    rawError: string;
    timestamp: string;
  }>;
  verificationEvidences: VerificationEvidence[];
  lastVerificationStep: number;
  stopBlockCount: number;
  metrics: SessionMetrics;
}

export interface SessionMetrics {
  totalToolCalls: number;
  failedToolCalls: number;
  deduplicatedReads: number;
  loopInterventions: number;
  verificationBlocks: number;
  measuredInputTokens: number;
  measuredOutputTokens: number;
  estimatedInputTokensSaved: number;
  estimatedContextTokensInjected: number;
  totalHookLatencyMs: number;
  taskExecutionTimeMs: number;
  finalVerificationStatus: VerificationStatus;
}

export type OptimizerMode = 'FAST' | 'BALANCED' | 'STRICT';

export interface OptimizerConfig {
  enabled: boolean;
  mode?: OptimizerMode;
  context: {
    enabled: boolean;
    maxRankedFiles: number;
    maxRepoMapTokens: number;
    deduplicateReads: boolean;
    blockRedundantFullReadsAfter: number;
    minQuerySpecificityForInjection: boolean;
  };
  verification: {
    enabled: boolean;
    enforceOnStop: boolean;
    autoRunFastTestsOnStop?: boolean;
    maxStopBlocksPerSession: number;
    requireTestsWhenCodeModified: boolean;
    exemptDocOnlyChanges: boolean;
    customTestCommand?: string;
    customBuildCommand?: string;
  };
  failureDetection: {
    enabled: boolean;
    maxRepeatedCommandFailures: number;
    maxIdenticalErrors: number;
    maxRedundantReadsOfUnchangedFile: number;
    detectEditOscillation: boolean;
  };
  memory: {
    enabled: boolean;
    maxEntries: number;
    minConfidenceToInject: number;
    autoPruneContradictions: boolean;
  };
}

