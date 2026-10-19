import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  NormalizedHookEvent,
  OptimizationDecision,
  OptimizerConfig,
  SessionState,
  SupportedPlatform,
} from '../types/index.js';
import { getAgentOptDir, loadConfig } from '../config/index.js';
import { ContextOptimizationEngine } from '../context/index.js';
import { TaskVerificationEngine } from '../verification/index.js';
import { FailureDetectionEngine } from '../failure/index.js';
import { CrossSessionMemoryStore } from '../memory/index.js';
import { countCalibratedTokens, sha256File, sha256String } from '../utils/tokens.js';
import {
  isSensitiveFilePath,
  sanitizeContextText,
  writeJsonAtomic,
} from '../security/index.js';

export interface OptimizerEngineOptions {
  cwd: string;
  config?: OptimizerConfig;
  /** Enables v2 post-evaluation optimizations (default: true) */
  enableV2Improvements?: boolean;
}

export class AgentOptimizerCore {
  public readonly cwd: string;
  public readonly config: OptimizerConfig;
  public readonly enableV2Improvements: boolean;
  public readonly contextEngine: ContextOptimizationEngine;
  public readonly verificationEngine: TaskVerificationEngine;
  public readonly failureEngine: FailureDetectionEngine;
  public readonly memoryStore: CrossSessionMemoryStore;

  constructor(options: OptimizerEngineOptions) {
    this.cwd = path.resolve(options.cwd);
    this.config = options.config ?? loadConfig(this.cwd);
    this.enableV2Improvements = options.enableV2Improvements ?? true;
    this.contextEngine = new ContextOptimizationEngine(this.cwd, this.config);
    this.verificationEngine = new TaskVerificationEngine(this.cwd, this.config);
    this.failureEngine = new FailureDetectionEngine(this.config);
    this.memoryStore = new CrossSessionMemoryStore(this.cwd, this.config);
  }

  /**
   * Processes any normalized lifecycle event from Claude Code, OpenAI Codex, Cursor, or Google Antigravity
   * and returns a provider-independent OptimizationDecision.
   */
  public handleEvent(event: NormalizedHookEvent): OptimizationDecision {
    const startPerf = performance.now();
    const session = this.loadOrCreateSession(event.sessionId, event.platform);

    if (!this.config.enabled) {
      return {
        action: 'allow',
        diagnostics: {
          contextTokensSaved: 0,
          contextTokensInjected: 0,
          deduplicatedRead: false,
          memoriesApplied: [],
          latencyMs: Number((performance.now() - startPerf).toFixed(2)),
        },
      };
    }

    // Track measured tokens when provided by platform
    if (typeof event.inputTokens === 'number' && event.inputTokens > 0) {
      session.metrics.measuredInputTokens += event.inputTokens;
    }
    if (typeof event.outputTokens === 'number' && event.outputTokens > 0) {
      session.metrics.measuredOutputTokens += event.outputTokens;
    }

    let decision: OptimizationDecision;

    switch (event.event) {
      case 'SessionStart':
        decision = this.handleSessionStart(session, event, startPerf);
        break;
      case 'UserPromptSubmit':
      case 'PreInvocation':
        decision = this.handlePromptOrPreInvocation(session, event, startPerf);
        break;
      case 'PreToolUse':
        decision = this.handlePreToolUse(session, event, startPerf);
        break;
      case 'PostToolUse':
      case 'PostInvocation':
        decision = this.handlePostToolUse(session, event, startPerf);
        break;
      case 'Stop':
      case 'SessionEnd':
        decision = this.handleStop(session, event, startPerf);
        break;
      default:
        decision = {
          action: 'allow',
          diagnostics: {
            contextTokensSaved: 0,
            contextTokensInjected: 0,
            deduplicatedRead: false,
            memoriesApplied: [],
            latencyMs: Number((performance.now() - startPerf).toFixed(2)),
          },
        };
    }

    session.updatedAt = new Date().toISOString();
    session.metrics.totalHookLatencyMs = Number(
      (session.metrics.totalHookLatencyMs + decision.diagnostics.latencyMs).toFixed(2)
    );
    this.saveSession(session);
    return decision;
  }

  private handleSessionStart(
    session: SessionState,
    _event: NormalizedHookEvent,
    startPerf: number
  ): OptimizationDecision {
    if (this.config.memory.enabled && this.memoryStore.loadAll().length === 0) {
      this.memoryStore.bootstrapFromWorkspace(session.sessionId);
    }

    // Warm up incremental repository graph and record session-scoped baseline hashes
    if (this.config.context.enabled) {
      const graph = this.contextEngine.buildRepoGraph();
      session.workspaceBaselineHashes = {};
      for (const [relPath, node] of Object.entries(graph)) {
        session.workspaceBaselineHashes[relPath] = node.sha256;
      }
    }

    const allMemories = this.config.memory.enabled
      ? this.memoryStore.getActiveMemoriesForInjection()
      : [];
    // Only auto-inject memories on SessionStart that were empirically confirmed by command execution
    const verifiedCommandMemories = allMemories.filter(
      (m) => Boolean(m.evidenceCommand) || m.verifiedCount >= 2
    );
    const blocks: string[] = [];
    if (this.config.memory.enabled && verifiedCommandMemories.length > 0) {
      const memText = this.memoryStore.formatMemoriesForPrompt();
      if (memText) blocks.push(memText);
    }
    if (_event.platform === 'cursor' && this.config.context.enabled) {
      const overview = this.contextEngine.buildSessionStartOverview();
      if (overview) blocks.push(overview);
    }
    const sanitizedBlock = sanitizeContextText(blocks.join('\n\n')).sanitized;
    const injectedTokens = countCalibratedTokens(sanitizedBlock);
    session.metrics.estimatedContextTokensInjected += injectedTokens;

    return {
      action: 'allow',
      injectedContext: sanitizedBlock || undefined,
      diagnostics: {
        contextTokensSaved: 0,
        contextTokensInjected: injectedTokens,
        deduplicatedRead: false,
        memoriesApplied: verifiedCommandMemories.map((m) => m.key),
        latencyMs: Number((performance.now() - startPerf).toFixed(2)),
      },
    };
  }

  private handlePromptOrPreInvocation(
    session: SessionState,
    event: NormalizedHookEvent,
    startPerf: number
  ): OptimizationDecision {
    const prompt = event.userPrompt || '';
    if (prompt && !session.initialPrompt) {
      session.initialPrompt = prompt;
    }

    // Check if the developer explicitly asked to skip verification/tests or stop immediately
    if (prompt && this.verificationEngine.isUserVerificationOptOut(prompt)) {
      session.userOptedOutOfVerification = true;
    }

    // Ensure session has baseline hashes initialized
    if (!session.workspaceBaselineHashes) {
      const graph = this.contextEngine.buildRepoGraph();
      session.workspaceBaselineHashes = {};
      for (const [relPath, node] of Object.entries(graph)) {
        session.workspaceBaselineHashes[relPath] = node.sha256;
      }
    }

    // Extract verifiable requirements from user prompt
    if (prompt && this.config.verification.enabled) {
      const newReqs = this.verificationEngine.extractRequirementsFromPrompt(prompt);
      for (const req of newReqs) {
        if (!session.extractedRequirements.some((r) => r.id === req.id)) {
          session.extractedRequirements.push(req);
        }
      }
    }

    const blocks: string[] = [];
    let tokensSaved = 0;
    const memoriesApplied: string[] = [];

    const promptNeedsProjectConventions =
      /\b(?:test|build|compile|bundle|script|config|import|dependency|setup)\b/i.test(prompt);

    if (
      this.config.memory.enabled &&
      session.stepCount === 0 &&
      session.metrics.estimatedContextTokensInjected === 0 &&
      promptNeedsProjectConventions
    ) {
      if (this.memoryStore.loadAll().length === 0) {
        this.memoryStore.bootstrapFromWorkspace(session.sessionId);
      }
      const memText = this.memoryStore.formatMemoriesForPrompt();
      if (memText) {
        blocks.push(memText);
        for (const m of this.memoryStore.getActiveMemoriesForInjection()) {
          memoriesApplied.push(m.key);
        }
      }
    }

    if (this.config.context.enabled && prompt.trim().length > 0) {
      const ctxResult = this.contextEngine.optimizeForQuery(prompt, session);
      if (ctxResult.rankedFiles.length > 0 && ctxResult.compactRepoMap) {
        blocks.push(ctxResult.compactRepoMap);
        tokensSaved = ctxResult.estimatedTokensSaved;
      }
    }

    const injectedContext = sanitizeContextText(blocks.join('\n\n')).sanitized;
    const injectedTokens = countCalibratedTokens(injectedContext);
    session.metrics.estimatedContextTokensInjected += injectedTokens;
    session.metrics.estimatedInputTokensSaved += tokensSaved;

    return {
      action: 'allow',
      injectedContext: injectedContext || undefined,
      diagnostics: {
        contextTokensSaved: tokensSaved,
        contextTokensInjected: injectedTokens,
        deduplicatedRead: false,
        memoriesApplied,
        latencyMs: Number((performance.now() - startPerf).toFixed(2)),
      },
    };
  }

  private handlePreToolUse(
    session: SessionState,
    event: NormalizedHookEvent,
    startPerf: number
  ): OptimizationDecision {
    const toolName = event.toolName || '';
    const toolInput = event.toolInput || {};

    // 1. Check for Redundant Consecutive File Reads on unchanged files
    if (/^(?:Read|view_file|read_file|cat)$/i.test(toolName)) {
      const targetFile =
        (toolInput.file_path as string) ||
        (toolInput.AbsolutePath as string) ||
        (toolInput.path as string);

      const hasExplicitLineRange = Boolean(
        toolInput.offset !== undefined ||
          toolInput.limit !== undefined ||
          toolInput.StartLine !== undefined ||
          toolInput.EndLine !== undefined ||
          toolInput.start_line !== undefined
      );

      if (targetFile) {
        const evalResult = this.contextEngine.evaluateFileRead(
          targetFile,
          hasExplicitLineRange,
          session
        );
        if (evalResult.isRedundant && evalResult.shouldBlock) {
          session.metrics.deduplicatedReads += 1;
          session.metrics.estimatedInputTokensSaved += evalResult.tokensSaved;
          const safeFeedback = sanitizeContextText(evalResult.feedback || '').sanitized;
          return {
            action: 'block',
            agentFeedback: safeFeedback,
            diagnostics: {
              contextTokensSaved: evalResult.tokensSaved,
              contextTokensInjected: countCalibratedTokens(safeFeedback),
              deduplicatedRead: true,
              memoriesApplied: [],
              latencyMs: Number((performance.now() - startPerf).toFixed(2)),
            },
          };
        }

        // Cursor fires beforeReadFile without a separate afterReadFile event, so record allowed reads here
        if (
          event.platform === 'cursor' &&
          event.rawPayload?.hook_event_name === 'beforeReadFile'
        ) {
          const normTarget = targetFile.replace(/\\/g, '/');
          const absPath = path.isAbsolute(normTarget)
            ? normTarget
            : path.resolve(this.cwd, normTarget);
          const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');
          const sha = sha256File(absPath);
          if (sha) {
            session.stepCount += 1;
            session.metrics.totalToolCalls += 1;
            const prev = session.fileReads[relPath];
            const wasImmediateSameFile =
              prev &&
              prev.sha256AtRead === sha &&
              session.lastToolTargetFile === relPath &&
              /^(?:Read|view_file|read_file)$/i.test(session.lastToolName || '');
            session.fileReads[relPath] = {
              relativePath: relPath,
              sha256AtRead: sha,
              readCount: prev && prev.sha256AtRead === sha ? prev.readCount + 1 : 1,
              consecutiveReads: wasImmediateSameFile
                ? (prev.consecutiveReads ?? 1) + 1
                : 1,
              firstReadStep: prev ? prev.firstReadStep : session.stepCount,
              lastReadStep: session.stepCount,
              estimatedTokens: countCalibratedTokens(
                (event.rawPayload?.content as string) || ''
              ),
            };
            session.lastToolName = 'Read';
            session.lastToolTargetFile = relPath;
          }
        }
      }
    }

    // 1b. Check for Redundant Identical Full-File Writes (writing the exact same content already written in this session)
    if (/^(?:Write|write_file|write_to_file)$/i.test(toolName) && this.config.context.enabled) {
      const targetFile =
        (toolInput.file_path as string) ||
        (toolInput.TargetFile as string) ||
        (toolInput.path as string) ||
        '';
      const newContent =
        (toolInput.content as string) ?? (toolInput.CodeContent as string);
      if (targetFile && typeof newContent === 'string') {
        const normTarget = targetFile.replace(/\\/g, '/');
        const absPath = path.isAbsolute(normTarget)
          ? normTarget
          : path.resolve(this.cwd, normTarget);
        const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');
        const existingMod = session.modifiedFiles[relPath];
        if (existingMod && existingMod.currentSha256 === sha256String(newContent)) {
          const feedback = `[AgentOpt Write Cache] '${relPath}' on disk already contains this exact content. Call finish_task or run verification instead of repeating the identical write.`;
          return {
            action: 'block',
            agentFeedback: feedback,
            diagnostics: {
              contextTokensSaved: countCalibratedTokens(newContent),
              contextTokensInjected: countCalibratedTokens(feedback),
              deduplicatedRead: true,
              memoriesApplied: [],
              latencyMs: Number((performance.now() - startPerf).toFixed(2)),
            },
          };
        }
      }
    }

    // 2. Check for Repeated Failing Shell Commands BEFORE executing the 3rd+ identical failure
    if (/^(?:Bash|run_command|shell)$/i.test(toolName) && this.config.failureDetection.enabled) {
      // Snapshot current workspace hashes right before this session's Bash command runs
      // so detectShellModifiedFiles only attributes changes made during this Bash command!
      if (this.enableV2Improvements) {
        const graph = this.contextEngine.buildRepoGraph();
        session.workspaceBaselineHashes = session.workspaceBaselineHashes || {};
        for (const [relPath, node] of Object.entries(graph)) {
          session.workspaceBaselineHashes[relPath] = node.sha256;
        }
      }

      const rawCmd =
        (toolInput.command as string) ||
        (toolInput.CommandLine as string) ||
        '';
      if (rawCmd) {
        const normCmd = this.failureEngine.normalizeCommand(rawCmd);
        const lastEditStep = Math.max(
          0,
          ...Object.values(session.modifiedFiles).map((m) => m.lastModifiedStep)
        );
        const priorFailuresSinceEdit = session.commandHistory.filter(
          (c) =>
            c.stepIndex > lastEditStep &&
            c.normalizedCommand === normCmd &&
            c.exitCode !== 0
        );

        if (
          priorFailuresSinceEdit.length >=
          this.config.failureDetection.maxRepeatedCommandFailures
        ) {
          session.metrics.loopInterventions += 1;
          const feedback =
            `[AgentOpt Pre-Execution Loop Guard] Blocked re-running \`${rawCmd}\` because it already failed ${priorFailuresSinceEdit.length} time(s) since the last file modification. ` +
            `Modify the relevant code or command arguments before running again.`;
          return {
            action: 'block',
            agentFeedback: feedback,
            diagnostics: {
              contextTokensSaved: 120,
              contextTokensInjected: countCalibratedTokens(feedback),
              deduplicatedRead: false,
              failurePatternDetected: 'REPEATED_COMMAND_FAILURE',
              memoriesApplied: [],
              latencyMs: Number((performance.now() - startPerf).toFixed(2)),
            },
          };
        }
      }
    }

    return {
      action: 'allow',
      diagnostics: {
        contextTokensSaved: 0,
        contextTokensInjected: 0,
        deduplicatedRead: false,
        memoriesApplied: [],
        latencyMs: Number((performance.now() - startPerf).toFixed(2)),
      },
    };
  }

  private handlePostToolUse(
    session: SessionState,
    event: NormalizedHookEvent,
    startPerf: number
  ): OptimizationDecision {
    session.stepCount += 1;
    session.metrics.totalToolCalls += 1;

    const toolName = event.toolName || '';
    const toolInput = event.toolInput || {};
    const outputStr =
      typeof event.toolOutput === 'string'
        ? event.toolOutput
        : event.toolOutput
          ? JSON.stringify(event.toolOutput)
          : '';
    const errorStr = event.toolError || '';

    const rawTargetFileInput =
      (toolInput.file_path as string) ||
      (toolInput.AbsolutePath as string) ||
      (toolInput.TargetFile as string) ||
      (toolInput.path as string);
    const rawTargetFile = rawTargetFileInput
      ? rawTargetFileInput.replace(/\\/g, '/')
      : undefined;
    const currentRelTarget = rawTargetFile
      ? path
          .relative(
            this.cwd,
            path.isAbsolute(rawTargetFile)
              ? rawTargetFile
              : path.resolve(this.cwd, rawTargetFile)
          )
          .split(path.sep)
          .join('/')
      : undefined;

    // 1. Track File Reads
    if (/^(?:Read|view_file|read_file)$/i.test(toolName) && !errorStr && rawTargetFile) {
      const absPath = path.isAbsolute(rawTargetFile)
        ? rawTargetFile
        : path.resolve(this.cwd, rawTargetFile);
      const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');
      const sha = sha256File(absPath);
      if (sha) {
        const prev = session.fileReads[relPath];
        const wasImmediateSameFile =
          prev &&
          prev.sha256AtRead === sha &&
          session.lastToolTargetFile === relPath &&
          /^(?:Read|view_file|read_file)$/i.test(session.lastToolName || '');

        session.fileReads[relPath] = {
          relativePath: relPath,
          sha256AtRead: sha,
          readCount: prev && prev.sha256AtRead === sha ? prev.readCount + 1 : 1,
          consecutiveReads: wasImmediateSameFile
            ? (prev.consecutiveReads ?? 1) + 1
            : 1,
          firstReadStep: prev ? prev.firstReadStep : session.stepCount,
          lastReadStep: session.stepCount,
          estimatedTokens: countCalibratedTokens(outputStr),
        };
      }
    }

    // 2. Track File Modifications
    if (
      /^(?:Edit|Write|MultiEdit|replace_file_content|write_to_file|afterFileEdit)$/i.test(
        toolName
      ) &&
      !errorStr &&
      rawTargetFile
    ) {
      this.recordFileModification(session, rawTargetFile, toolInput);
    } else if (/^(?:apply_patch|patch)$/i.test(toolName) && !errorStr && this.enableV2Improvements) {
      this.detectShellModifiedFiles(session);
    }

    // 3. Track Shell Commands & Verification Outcomes
    let extraDiagnosticContext = '';
    if (/^(?:Bash|run_command|shell|afterShellExecution)$/i.test(toolName)) {
      const rawCmd =
        (toolInput.command as string) ||
        (toolInput.CommandLine as string) ||
        '';
      const exitCode =
        typeof event.exitCode === 'number'
          ? event.exitCode
          : errorStr
            ? 1
            : 0;

      if (this.enableV2Improvements) {
        this.detectShellModifiedFiles(session);
      }

      if (rawCmd) {
        const normCmd = this.failureEngine.normalizeCommand(rawCmd);
        const isVerificationCmd = Boolean(
          this.verificationEngine.classifyVerificationCommand(rawCmd)
        );
        const errSig =
          exitCode !== 0
            ? this.failureEngine.normalizeErrorSignature(`${errorStr}\n${outputStr}`)
            : undefined;

        session.commandHistory.push({
          stepIndex: session.stepCount,
          command: rawCmd,
          normalizedCommand: normCmd,
          exitCode,
          errorSignature: errSig,
          timestamp: event.timestamp,
          isVerificationCmd,
        });

        if (exitCode !== 0) {
          session.metrics.failedToolCalls += 1;
          if (errSig) {
            session.toolErrorHistory.push({
              stepIndex: session.stepCount,
              toolName,
              errorSignature: errSig,
              rawError: `${errorStr}\n${outputStr}`.trim().slice(0, 300),
              timestamp: event.timestamp,
            });
          }
          if (/missing script|command not found/i.test(`${errorStr}\n${outputStr}`)) {
            this.memoryStore.recordContradiction(
              'test_command',
              rawCmd,
              `Command '${rawCmd}' failed with missing script/command`
            );
          }

          if (this.enableV2Improvements && isVerificationCmd) {
            const snippet = this.extractFailureCodeSnippet(`${errorStr}\n${outputStr}`);
            if (snippet) {
              extraDiagnosticContext = snippet;
            }
          }
        } else if (isVerificationCmd && this.config.memory.enabled) {
          const vType = this.verificationEngine.classifyVerificationCommand(rawCmd);
          if (vType === 'test_execution' || vType === 'build_execution') {
            this.memoryStore.upsertVerifiedMemory({
              category: vType === 'test_execution' ? 'test_command' : 'build_command',
              key: `verified_${vType}`,
              value: `\`${rawCmd}\` (verified passing with exit code 0)`,
              confidence: 0.92,
              sourceSessionId: session.sessionId,
              evidenceCommand: rawCmd,
            });
          }
        }

        this.verificationEngine.recordCommandOutcome(
          session,
          rawCmd,
          exitCode,
          `${errorStr}\n${outputStr}`.trim()
        );
      }
    } else if (errorStr) {
      session.metrics.failedToolCalls += 1;
      const errSig = this.failureEngine.normalizeErrorSignature(errorStr);
      session.toolErrorHistory.push({
        stepIndex: session.stepCount,
        toolName,
        errorSignature: errSig,
        rawError: errorStr.slice(0, 300),
        timestamp: event.timestamp,
      });
    }

    session.lastToolName = toolName;
    session.lastToolTargetFile = currentRelTarget;

    // 4. Analyze for Failure Patterns & Loops
    const detectedPattern = this.failureEngine.analyzePostTool(
      session,
      toolName,
      toolInput,
      event.exitCode,
      errorStr,
      outputStr
    );

    const feedbackParts: string[] = [];
    if (detectedPattern) {
      session.metrics.loopInterventions += 1;
      feedbackParts.push(detectedPattern.actionableFeedback);
    }
    if (extraDiagnosticContext) {
      feedbackParts.push(extraDiagnosticContext);
    }

    const rawCombined = feedbackParts.join('\n\n');
    const combinedFeedback = rawCombined
      ? sanitizeContextText(rawCombined).sanitized
      : undefined;
    const injectedTokens = countCalibratedTokens(combinedFeedback || '');
    session.metrics.estimatedContextTokensInjected += injectedTokens;

    return {
      action: detectedPattern?.shouldInterruptTool ? 'block' : 'allow',
      agentFeedback: combinedFeedback,
      injectedContext: combinedFeedback,
      diagnostics: {
        contextTokensSaved: extraDiagnosticContext ? 220 : 0,
        contextTokensInjected: injectedTokens,
        deduplicatedRead: false,
        failurePatternDetected: detectedPattern?.type,
        memoriesApplied: [],
        latencyMs: Number((performance.now() - startPerf).toFixed(2)),
      },
    };
  }

  private handleStop(
    session: SessionState,
    event: NormalizedHookEvent,
    startPerf: number
  ): OptimizationDecision {
    const rawPayload = event.rawPayload || {};
    const lastMessage =
      (rawPayload.last_assistant_message as string) ||
      (event.toolOutput as string) ||
      '';

    const stopHookAlreadyActive = Boolean(rawPayload.stop_hook_active);
    const terminationReason = String(rawPayload.terminationReason || '');
    const userInitiatedStop =
      Boolean(rawPayload.user_requested_stop) ||
      /^(?:user_cancel|user_stop|interrupted|aborted|max_steps_exceeded)$/i.test(
        terminationReason
      );

    let report = this.verificationEngine.evaluate(
      session,
      lastMessage,
      userInitiatedStop
    );
    session.metrics.finalVerificationStatus = report.status;

    if (this.config.mode === 'FAST' || !this.config.verification.enabled) {
      return {
        action: 'allow',
        diagnostics: {
          contextTokensSaved: 0,
          contextTokensInjected: 0,
          deduplicatedRead: false,
          verificationStatus: report.status,
          memoriesApplied: [],
          latencyMs: Number((performance.now() - startPerf).toFixed(2)),
        },
      };
    }

    // Loop safety guard:
    // If stop_hook_active is true and we already blocked once in this session, NEVER block again
    // so we never trap the agent in an infinite continuation loop.
    const canBlockAgain = stopHookAlreadyActive
      ? session.stopBlockCount < 1
      : session.stopBlockCount < this.config.verification.maxStopBlocksPerSession;

    // In BALANCED mode (or when autoRunFastTestsOnStop is enabled), if meaningful source changes
    // exist without a post-edit test run and real test files exist on disk, run the fast verification
    // check in-hook. If tests pass (exitCode === 0), allow Stop immediately with 0 extra LLM turns!
    // Only block Stop if the test suite or requirement verification actually FAILS.
    if (
      canBlockAgain &&
      report.shouldBlockStop &&
      report.status === 'NOT_VERIFIED' &&
      this.config.verification.autoRunFastTestsOnStop !== false &&
      report.dirtyFilesSinceLastVerification.length > 0 &&
      this.hasTestFilesOnDisk()
    ) {
      const cmd = report.recommendedCommands[0] || 'npm test';
      this.runSilentVerificationProbe(session, cmd);
      report = this.verificationEngine.evaluate(
        session,
        lastMessage,
        userInitiatedStop
      );
      session.metrics.finalVerificationStatus = report.status;
    }

    if (report.shouldBlockStop && canBlockAgain) {
      session.stopBlockCount += 1;
      session.metrics.verificationBlocks += 1;

      const feedbackBlocks: string[] = [
        `[AgentOpt Task Verification Gate — Status: ${report.status}] ${report.summary}`,
      ];

      if (report.status === 'FAILED') {
        const latestFailed = [...session.verificationEvidences]
          .reverse()
          .find((e) => !e.passed);
        if (latestFailed && latestFailed.summary) {
          feedbackBlocks.push(
            `[Verification Command Output (exit code ${latestFailed.exitCode ?? 1})]:\n${latestFailed.summary}`
          );
          const snippet = this.extractFailureCodeSnippet(latestFailed.summary);
          if (snippet) {
            feedbackBlocks.push(snippet);
          }
        }
        const currentFilesBlock = this.formatModifiedSourceFilesForRecovery(
          report.modifiedSourceFiles
        );
        if (currentFilesBlock) {
          feedbackBlocks.push(currentFilesBlock);
        }
      }

      const feedback = sanitizeContextText(feedbackBlocks.join('\n\n')).sanitized;
      const injectedTokens = countCalibratedTokens(feedback);
      session.metrics.estimatedContextTokensInjected += injectedTokens;

      return {
        action: 'block',
        agentFeedback: feedback,
        injectedContext: feedback,
        diagnostics: {
          contextTokensSaved: 0,
          contextTokensInjected: injectedTokens,
          deduplicatedRead: false,
          verificationStatus: report.status,
          memoriesApplied: [],
          latencyMs: Number((performance.now() - startPerf).toFixed(2)),
        },
      };
    }

    return {
      action: 'allow',
      diagnostics: {
        contextTokensSaved: 0,
        contextTokensInjected: 0,
        deduplicatedRead: false,
        verificationStatus: report.status,
        memoriesApplied: [],
        latencyMs: Number((performance.now() - startPerf).toFixed(2)),
      },
    };
  }

  private hasTestFilesOnDisk(): boolean {
    const testDirs = ['test', 'tests', '__tests__'];
    for (const d of testDirs) {
      const abs = path.join(this.cwd, d);
      if (fs.existsSync(abs)) {
        try {
          const entries = fs.readdirSync(abs);
          if (entries.some((e) => /\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs|py)$/i.test(e))) {
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  private runSilentVerificationProbe(session: SessionState, cmd: string): void {
    session.stepCount += 1;
    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const res = spawnSync(cmd, {
      cwd: this.cwd,
      shell: true,
      encoding: 'utf-8',
      timeout: 5000,
      env: cleanEnv,
    });
    const exitCode = res.status ?? 1;
    const output = `${res.stdout || ''}\n${res.stderr || ''}`.trim().slice(0, 900);
    const normCmd = this.failureEngine.normalizeCommand(cmd);
    session.commandHistory.push({
      stepIndex: session.stepCount,
      command: cmd,
      normalizedCommand: normCmd,
      exitCode,
      timestamp: new Date().toISOString(),
      isVerificationCmd: true,
    });
    this.verificationEngine.recordCommandOutcome(session, cmd, exitCode, output);
  }

  private formatModifiedSourceFilesForRecovery(modifiedSourceFiles: string[]): string {
    const blocks: string[] = [];
    for (const relPath of modifiedSourceFiles.slice(0, 2)) {
      if (isSensitiveFilePath(relPath)) continue;
      const absPath = path.resolve(this.cwd, relPath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        if (lines.length <= 60) {
          blocks.push(
            `[Current Modified File on Disk: ${relPath} — inspect carefully and fix the bug with write_file]\n\`\`\`js\n${content}\n\`\`\``
          );
        }
      } catch {
        continue;
      }
    }
    return blocks.join('\n\n');
  }

  private recordFileModification(
    session: SessionState,
    targetFile: string,
    toolInput?: Record<string, unknown>
  ): void {
    const normTarget = targetFile.replace(/\\/g, '/');
    const absPath = path.isAbsolute(normTarget)
      ? normTarget
      : path.resolve(this.cwd, normTarget);
    const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');
    const currentSha = sha256File(absPath) || sha256String(`deleted:${Date.now()}`);

    // Determine whether this edit contains substantive code changes (not just comments/whitespace)
    let isSubstantive = true;
    const oldStr =
      (toolInput?.old_string as string) ?? (toolInput?.TargetContent as string);
    const newStr =
      (toolInput?.new_string as string) ?? (toolInput?.ReplacementContent as string);
    if (typeof oldStr === 'string' && typeof newStr === 'string') {
      const strippedOld = this.verificationEngine.stripComments(oldStr).replace(/\s+/g, '');
      const strippedNew = this.verificationEngine.stripComments(newStr).replace(/\s+/g, '');
      isSubstantive = strippedOld !== strippedNew;
    } else if (fs.existsSync(absPath)) {
      try {
        const diskContent = fs.readFileSync(absPath, 'utf-8');
        const strippedDisk = this.verificationEngine
          .stripComments(diskContent)
          .replace(/\s+/g, '');
        isSubstantive = strippedDisk.length > 0;
      } catch {
        isSubstantive = true;
      }
    }

    const prev = session.modifiedFiles[relPath];
    if (prev) {
      prev.editCount += 1;
      prev.lastModifiedStep = session.stepCount;
      prev.currentSha256 = currentSha;
      if (prev.sha256History[prev.sha256History.length - 1] !== currentSha) {
        prev.sha256History.push(currentSha);
      }
      prev.hasSubstantiveCodeChange = Boolean(
        prev.hasSubstantiveCodeChange || isSubstantive
      );
    } else {
      let initialSha: string | undefined =
        session.fileReads[relPath]?.sha256AtRead ||
        session.workspaceBaselineHashes?.[relPath];
      if (!initialSha) {
        const cachePath = path.join(getAgentOptDir(this.cwd), 'cache', 'repo-graph.json');
        if (fs.existsSync(cachePath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
              files?: Record<string, { sha256?: string }>;
            };
            initialSha = parsed.files?.[relPath]?.sha256;
          } catch {
            // Ignore
          }
        }
      }
      session.modifiedFiles[relPath] = {
        relativePath: relPath,
        editCount: 1,
        firstModifiedStep: session.stepCount,
        lastModifiedStep: session.stepCount,
        sha256History:
          initialSha && initialSha !== currentSha
            ? [initialSha, currentSha]
            : [currentSha],
        currentSha256: currentSha,
        hasSubstantiveCodeChange: isSubstantive,
      };
    }

    if (session.workspaceBaselineHashes) {
      session.workspaceBaselineHashes[relPath] = currentSha;
    }
  }

  /**
   * Detects source files modified on disk during this session's Bash command execution
   * by comparing against session.workspaceBaselineHashes.
   */
  private detectShellModifiedFiles(session: SessionState): void {
    const baseline = session.workspaceBaselineHashes;
    const cachePath = path.join(getAgentOptDir(this.cwd), 'cache', 'repo-graph.json');
    if (!fs.existsSync(cachePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as {
        files?: Record<string, { relativePath: string; absolutePath: string; sha256: string }>;
      };
      if (!parsed.files) return;
      for (const [relPath, node] of Object.entries(parsed.files)) {
        const expectedSha = baseline?.[relPath] ?? node.sha256;
        const resolvedAbs = path.resolve(this.cwd, relPath);
        const diskSha = sha256File(resolvedAbs) ?? sha256File(node.absolutePath);
        if (diskSha && diskSha !== expectedSha) {
          const alreadyRecorded = session.modifiedFiles[relPath];
          if (!alreadyRecorded || alreadyRecorded.currentSha256 !== diskSha) {
            this.recordFileModification(session, relPath);
          }
        }
      }
    } catch {
      // Ignore cache read errors
    }
  }

  /**
   * Parses stack trace file:line references from failing test/build output
   * and returns a sanitized 15-line source snippet around the failure site.
   */
  private extractFailureCodeSnippet(errorOutput: string): string | null {
    const fileLineRegex =
      /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs)):(\d+)(?::\d+)?/g;
    let m: RegExpExecArray | null;
    while ((m = fileLineRegex.exec(errorOutput)) !== null) {
      let candidateRel = m[1].replace(/^\.\//, '');
      if (candidateRel.startsWith('dist/') && candidateRel.endsWith('.js')) {
        const srcCandidate = candidateRel
          .replace(/^dist\//, 'src/')
          .replace(/\.js$/, '.ts');
        if (fs.existsSync(path.resolve(this.cwd, srcCandidate))) {
          candidateRel = srcCandidate;
        }
      }
      if (isSensitiveFilePath(candidateRel)) continue;
      const absPath = path.resolve(this.cwd, candidateRel);
      if (!fs.existsSync(absPath) || absPath.includes('node_modules')) continue;

      const lineNum = parseInt(m[2], 10);
      if (isNaN(lineNum) || lineNum < 1) continue;

      try {
        const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
        const start = Math.max(1, lineNum - 6);
        const end = Math.min(lines.length, lineNum + 8);
        const snippetLines: string[] = [
          `[AgentOpt Failure Pinpoint — ${candidateRel}:L${start}-${end} around line ${lineNum}]`,
        ];
        for (let i = start; i <= end; i++) {
          const marker = i === lineNum ? '>>' : '  ';
          snippetLines.push(`${marker} ${i}: ${lines[i - 1]}`);
        }
        return sanitizeContextText(snippetLines.join('\n')).sanitized;
      } catch {
        continue;
      }
    }
    return null;
  }

  public getSessionsDir(): string {
    return path.join(getAgentOptDir(this.cwd), 'sessions');
  }

  public loadOrCreateSession(
    sessionId: string,
    platform: SupportedPlatform = 'claude-code'
  ): SessionState {
    const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
    const sessionFile = path.join(this.getSessionsDir(), `${safeId}.json`);
    const now = new Date().toISOString();
    const defaultMetrics = {
      totalToolCalls: 0,
      failedToolCalls: 0,
      deduplicatedReads: 0,
      loopInterventions: 0,
      verificationBlocks: 0,
      measuredInputTokens: 0,
      measuredOutputTokens: 0,
      estimatedInputTokensSaved: 0,
      estimatedContextTokensInjected: 0,
      totalHookLatencyMs: 0,
      taskExecutionTimeMs: 0,
      finalVerificationStatus: 'NOT_VERIFIED' as const,
    };

    if (fs.existsSync(sessionFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as Partial<SessionState>;
        if (raw && typeof raw === 'object') {
          return {
            sessionId: raw.sessionId || safeId,
            platform: raw.platform || platform,
            cwd: raw.cwd || this.cwd,
            startedAt: raw.startedAt || now,
            updatedAt: raw.updatedAt || now,
            stepCount: typeof raw.stepCount === 'number' ? raw.stepCount : 0,
            initialPrompt: raw.initialPrompt,
            extractedRequirements: Array.isArray(raw.extractedRequirements)
              ? raw.extractedRequirements
              : [],
            fileReads: raw.fileReads && typeof raw.fileReads === 'object' ? raw.fileReads : {},
            modifiedFiles:
              raw.modifiedFiles && typeof raw.modifiedFiles === 'object' ? raw.modifiedFiles : {},
            commandHistory: Array.isArray(raw.commandHistory) ? raw.commandHistory : [],
            toolErrorHistory: Array.isArray(raw.toolErrorHistory) ? raw.toolErrorHistory : [],
            verificationEvidences: Array.isArray(raw.verificationEvidences)
              ? raw.verificationEvidences
              : [],
            lastVerificationStep:
              typeof raw.lastVerificationStep === 'number' ? raw.lastVerificationStep : 0,
            stopBlockCount: typeof raw.stopBlockCount === 'number' ? raw.stopBlockCount : 0,
            userOptedOutOfVerification: raw.userOptedOutOfVerification,
            lastToolName: raw.lastToolName,
            lastToolTargetFile: raw.lastToolTargetFile,
            workspaceBaselineHashes: raw.workspaceBaselineHashes,
            metrics: { ...defaultMetrics, ...(raw.metrics || {}) },
          };
        }
      } catch {
        // Recreate if corrupted
      }
    }

    return {
      sessionId: safeId,
      platform,
      cwd: this.cwd,
      startedAt: now,
      updatedAt: now,
      stepCount: 0,
      extractedRequirements: [],
      fileReads: {},
      modifiedFiles: {},
      commandHistory: [],
      toolErrorHistory: [],
      verificationEvidences: [],
      lastVerificationStep: 0,
      stopBlockCount: 0,
      metrics: defaultMetrics,
    };
  }

  public saveSession(session: SessionState): void {
    const sessionFile = path.join(this.getSessionsDir(), `${session.sessionId}.json`);
    writeJsonAtomic(sessionFile, session);
  }

  public listSessions(): SessionState[] {
    const dir = this.getSessionsDir();
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
    const sessions: SessionState[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(
          fs.readFileSync(path.join(dir, f), 'utf-8')
        ) as SessionState;
        sessions.push(s);
      } catch {
        continue;
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return sessions;
  }
}
