import {
  DetectedFailurePattern,
  OptimizerConfig,
  SessionState,
} from '../types/index.js';
import { sha256String } from '../utils/tokens.js';

export class FailureDetectionEngine {
  private config: OptimizerConfig;

  constructor(config: OptimizerConfig) {
    this.config = config;
  }

  /**
   * Normalizes error output by stripping timestamps, line numbers, memory addresses,
   * and process IDs to compute a stable error signature.
   */
  public normalizeErrorSignature(rawError: string): string {
    if (!rawError) return '';
    const cleaned = rawError
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
      .replace(/0x[0-9a-fA-F]+/g, '<ADDR>')
      .replace(/:\d+:\d+/g, ':<LINE>:<COL>')
      .replace(/\bpid\s+\d+/gi, 'pid <PID>')
      .trim()
      .slice(0, 400);
    return sha256String(cleaned).slice(0, 16);
  }

  /**
   * Normalizes shell commands so whitespace variations match.
   */
  public normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, ' ');
  }

  /**
   * Inspects a completed tool call or shell execution for failure patterns.
   * Carefully distinguishes healthy exploration / test-edit-retest cycles from unproductive loops.
   */
  public analyzePostTool(
    session: SessionState,
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    exitCode: number | undefined,
    errorText: string | undefined,
    outputText: string | undefined
  ): DetectedFailurePattern | null {
    if (!this.config.failureDetection.enabled) return null;

    const combinedOutput = `${errorText ?? ''}\n${outputText ?? ''}`.trim();

    // 1. Check for Missing Dependencies (immediate actionable diagnosis)
    const missingDep = this.detectMissingDependency(combinedOutput, exitCode);
    if (missingDep) {
      return missingDep;
    }

    // 2. Check for Broken Tool Calls (e.g. Edit old_string mismatch, missing path)
    const brokenTool = this.detectBrokenToolCall(toolName, toolInput, errorText || outputText);
    if (brokenTool) {
      return brokenTool;
    }

    // 3. Check for Edit Oscillation Loop (file SHA-256 reverting A -> B -> A)
    if (
      this.config.failureDetection.detectEditOscillation &&
      /^(?:Edit|Write|MultiEdit|replace_file_content|write_to_file)$/i.test(toolName)
    ) {
      const oscillation = this.detectEditOscillation(session);
      if (oscillation) {
        return oscillation;
      }
    }

    // 4. Check for Repeated Unsuccessful Command without intervening code edits
    if (session.commandHistory.length >= 2) {
      const latestCmd = session.commandHistory[session.commandHistory.length - 1];
      if (latestCmd.exitCode !== 0) {
        const lastEditStep = Math.max(
          0,
          ...Object.values(session.modifiedFiles).map((m) => m.lastModifiedStep)
        );

        // Count how many times this exact normalized command failed SINCE the last file edit
        const failuresSinceLastEdit = session.commandHistory.filter(
          (c) =>
            c.stepIndex > lastEditStep &&
            c.normalizedCommand === latestCmd.normalizedCommand &&
            c.exitCode !== 0
        );

        if (
          failuresSinceLastEdit.length >=
          this.config.failureDetection.maxRepeatedCommandFailures
        ) {
          return {
            type: 'REPEATED_COMMAND_FAILURE',
            severity: 'critical',
            occurrences: failuresSinceLastEdit.length,
            evidenceSummary: `Command \`${latestCmd.command}\` failed ${failuresSinceLastEdit.length} times in a row (exit code ${latestCmd.exitCode}) with zero file modifications in between.`,
            actionableFeedback:
              `[AgentOpt Loop Breaker] You have run \`${latestCmd.command}\` ${failuresSinceLastEdit.length} times without modifying any files, and it failed each time. ` +
              `Stop re-running the identical failing command. Inspect the error output above, edit the relevant source or test file first, and only then re-run.`,
            shouldInterruptTool: true,
          };
        }
      }
    }

    // 5. Check for Repeated Identical Error Signature across steps (even across different commands/edits)
    if (session.toolErrorHistory.length >= this.config.failureDetection.maxIdenticalErrors) {
      const latestErr = session.toolErrorHistory[session.toolErrorHistory.length - 1];
      if (latestErr && latestErr.stepIndex === session.stepCount) {
        const matchingErrors = session.toolErrorHistory.filter(
          (e) => e.errorSignature === latestErr.errorSignature
        );
        if (matchingErrors.length >= this.config.failureDetection.maxIdenticalErrors + 1) {
          return {
            type: 'IDENTICAL_ERROR_LOOP',
            severity: 'critical',
            occurrences: matchingErrors.length,
            evidenceSummary: `Identical error signature (${latestErr.errorSignature}) has occurred ${matchingErrors.length} times across recent steps.`,
            actionableFeedback:
              `[AgentOpt Failure Detector] The exact same error has repeated ${matchingErrors.length} times: "${latestErr.rawError.slice(0, 180)}". ` +
              `Your current hypothesis is not resolving the root cause. Pause, inspect the call site and caller dependencies, and try a different approach.`,
            shouldInterruptTool: false,
          };
        }
      }
    }

    // 6. Check for Stalled Progress (many tool calls with failing errors and no successful verification)
    if (session.stepCount >= 8 && session.toolErrorHistory.length >= 5) {
      const recentErrors = session.toolErrorHistory.filter(
        (e) => e.stepIndex > session.stepCount - 5
      );
      if (recentErrors.length >= 4) {
        return {
          type: 'STALLED_PROGRESS',
          severity: 'warning',
          occurrences: recentErrors.length,
          evidenceSummary: `${recentErrors.length} of the last 5 tool executions resulted in errors without forward progress.`,
          actionableFeedback:
            `[AgentOpt Progress Monitor] 4 of the last 5 operations failed. Re-verify file paths, symbol signatures, and project build configuration before making additional blind attempts.`,
          shouldInterruptTool: false,
        };
      }
    }

    return null;
  }

  private detectMissingDependency(
    output: string,
    exitCode?: number
  ): DetectedFailurePattern | null {
    if (!output || (exitCode === 0 && !/error|cannot find|not found/i.test(output))) {
      return null;
    }

    // Node/TS relative .js extension error in NodeNext
    const tsJsExtMatch = output.match(
      /Cannot find module ['"](\.[^'"]+)['"] or its corresponding type declarations/i
    );
    if (tsJsExtMatch) {
      return {
        type: 'MISSING_DEPENDENCY',
        severity: 'warning',
        occurrences: 1,
        evidenceSummary: `Module resolution failed for relative import '${tsJsExtMatch[1]}'.`,
        actionableFeedback:
          `[AgentOpt Dependency Diagnostic] Cannot resolve '${tsJsExtMatch[1]}'. Verify whether the target file exists and check if this TypeScript project uses "moduleResolution": "NodeNext" (which requires '.js' extensions in relative TypeScript imports).`,
        shouldInterruptTool: false,
      };
    }

    // Node missing package
    const nodeMissingMatch = output.match(
      /(?:Cannot find package|Cannot find module)\s+['"]([^.'"\/][^'"]*)['"]/i
    );
    if (nodeMissingMatch) {
      const pkg = nodeMissingMatch[1];
      return {
        type: 'MISSING_DEPENDENCY',
        severity: 'warning',
        occurrences: 1,
        evidenceSummary: `Missing Node dependency '${pkg}'.`,
        actionableFeedback:
          `[AgentOpt Dependency Diagnostic] Package '${pkg}' is not installed in node_modules. Check package.json to see if an alternative built-in API (like 'node:test', 'node:crypto', 'node:fs') should be used instead, or run 'npm install' if dependencies were not installed.`,
        shouldInterruptTool: false,
      };
    }

    // Python ModuleNotFoundError
    const pyMissingMatch = output.match(/ModuleNotFoundError:\s+No module named\s+['"]([^'"]+)['"]/i);
    if (pyMissingMatch) {
      return {
        type: 'MISSING_DEPENDENCY',
        severity: 'warning',
        occurrences: 1,
        evidenceSummary: `Missing Python module '${pyMissingMatch[1]}'.`,
        actionableFeedback:
          `[AgentOpt Dependency Diagnostic] Python module '${pyMissingMatch[1]}' is missing. Check the active virtual environment or pyproject.toml/requirements.txt before retrying.`,
        shouldInterruptTool: false,
      };
    }

    // Shell command not found
    const cmdNotFoundMatch = output.match(
      /(?:command not found|not recognized as an internal or external command):\s*([A-Za-z0-9_-]+)/i
    );
    if (cmdNotFoundMatch) {
      return {
        type: 'MISSING_DEPENDENCY',
        severity: 'warning',
        occurrences: 1,
        evidenceSummary: `Binary '${cmdNotFoundMatch[1]}' not found in PATH.`,
        actionableFeedback:
          `[AgentOpt Dependency Diagnostic] Command '${cmdNotFoundMatch[1]}' is not installed on PATH. Try running via local package runner (e.g., 'npx ${cmdNotFoundMatch[1]}') or check package.json scripts.`,
        shouldInterruptTool: false,
      };
    }

    return null;
  }

  private detectBrokenToolCall(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
    errorOrOutput?: string
  ): DetectedFailurePattern | null {
    if (!errorOrOutput) return null;

    if (
      /^(?:Edit|MultiEdit|replace_file_content)$/i.test(toolName) &&
      /(?:old_string|targetContent|not found in file|no match|multiple matches|exact match)/i.test(
        errorOrOutput
      )
    ) {
      const filePath =
        (toolInput?.file_path as string) ||
        (toolInput?.TargetFile as string) ||
        'target file';
      return {
        type: 'BROKEN_TOOL_CALL',
        severity: 'warning',
        occurrences: 1,
        evidenceSummary: `Edit tool call on '${filePath}' failed due to non-matching or ambiguous target text.`,
        actionableFeedback:
          `[AgentOpt Tool Repair] Edit failed on '${filePath}' because the target string did not exactly match current file contents. Read the specific line range around the target symbol in '${filePath}' to get exact whitespace and lines before calling Edit again.`,
        shouldInterruptTool: false,
      };
    }

    return null;
  }

  private detectEditOscillation(session: SessionState): DetectedFailurePattern | null {
    for (const mod of Object.values(session.modifiedFiles)) {
      const hist = mod.sha256History;
      // If a file has been edited multiple times and its current SHA-256 reverts to an earlier SHA-256
      // after a distinct intermediate state (H1 -> H2 -> H1, not a consecutive duplicate H1 -> H2 -> H2)
      if (hist.length >= 3) {
        const latestSha = hist[hist.length - 1];
        const immediatelyPrecedingSha = hist[hist.length - 2];
        if (latestSha !== immediatelyPrecedingSha) {
          const previousIndex = hist.slice(0, hist.length - 2).indexOf(latestSha);
          if (previousIndex !== -1) {
            return {
              type: 'EDIT_OSCILLATION_LOOP',
              severity: 'critical',
              occurrences: hist.length - 1,
              evidenceSummary: `'${mod.relativePath}' was reverted back to a previous state (SHA-256 ${latestSha.slice(0, 8)}) after ${hist.length - 1} edits (A -> B -> A oscillation).`,
              actionableFeedback:
                `[AgentOpt Thrash Detector] You are oscillating edits on '${mod.relativePath}' — its content just returned to a previous state you already tried. Stop toggling the same lines back and forth; review why the earlier state failed and formulate a distinct fix.`,
              shouldInterruptTool: false,
            };
          }
        }
      }
    }
    return null;
  }
}
