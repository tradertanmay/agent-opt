import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EvidenceType,
  OptimizerConfig,
  RequirementCheck,
  SessionState,
  VerificationEvidence,
  VerificationReport,
} from '../types/index.js';

const DOC_ONLY_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.license',
]);

const TEST_CMD_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\bnpx\s+(?:vitest|jest|mocha|ava|playwright|cypress)\b/i,
  /\bnode\s+--test\b/i,
  /\bpytest\b/i,
  /\bpython3?\s+-m\s+unittest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
];

const BUILD_CMD_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|compile)\b/i,
  /\bnpx\s+tsc\b/i,
  /\btsc\b/i,
  /\bcargo\s+(?:build|check)\b/i,
  /\bgo\s+build\b/i,
];

const LINT_CMD_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:lint|typecheck|check)\b/i,
  /\bnpx\s+(?:eslint|biome|prettier)\b/i,
  /\bruff\s+check\b/i,
  /\bflake8\b/i,
  /\bmypy\b/i,
];

export class TaskVerificationEngine {
  private cwd: string;
  private config: OptimizerConfig;

  constructor(cwd: string, config: OptimizerConfig) {
    this.cwd = cwd;
    this.config = config;
  }

  /**
   * Detects whether the user's prompt explicitly asks to skip tests/verification or stop immediately.
   */
  public isUserVerificationOptOut(prompt: string): boolean {
    if (!prompt) return false;
    return /\b(?:do\s+not|don't|skip|without|no\s+need\s+to)\s+(?:run(?:ning)?\s+)?(?:any\s+)?(?:tests?|verification|build|typecheck)\b|\b(?:just\s+draft|stop\s+now|stop\s+immediately)\b/i.test(
      prompt
    );
  }

  /**
   * Extracts verifiable requirements (e.g., required function/class names or target files)
   * mentioned in backticks or explicit directives in the user's prompt.
   * Ignores pure question-answering prompts (e.g., "What does `foo` do?").
   */
  public extractRequirementsFromPrompt(prompt: string): RequirementCheck[] {
    if (!prompt || !prompt.trim()) return [];
    // Do not extract code-modification requirements from pure Q&A prompts
    if (this.isQuestionOnlyPrompt(prompt)) {
      return [];
    }

    const checks: RequirementCheck[] = [];
    const seen = new Set<string>();

    // Pattern 1: Explicit function/class/method creation or update requirements in backticks
    const symbolDirectiveRegex =
      /\b(?:implement|add|create|export|define|fix|update|function|method|class|interface|type)\s+(?:and\s+export\s+)?`([A-Za-z_$][A-Za-z0-9_$]{2,})`/gi;
    let m: RegExpExecArray | null;
    while ((m = symbolDirectiveRegex.exec(prompt)) !== null) {
      const sym = m[1];
      if (seen.has(`sym:${sym}`)) continue;
      seen.add(`sym:${sym}`);
      checks.push({
        id: `req_sym_${sym}`,
        description: `Codebase defines or exports symbol '${sym}' with substantive implementation`,
        requiredSymbolOrPattern: sym,
        satisfied: false,
        details: 'Not checked yet',
      });
    }

    // Pattern 2: Explicit file creation/modification requirements in backticks
    const fileDirectiveRegex =
      /`([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs))`/g;
    while ((m = fileDirectiveRegex.exec(prompt)) !== null) {
      const relFile = m[1].replace(/^\.\//, '');
      if (seen.has(`file:${relFile}`)) continue;
      seen.add(`file:${relFile}`);
      checks.push({
        id: `req_file_${relFile.replace(/[^A-Za-z0-9]/g, '_')}`,
        description: `Target file '${relFile}' exists`,
        targetFile: relFile,
        satisfied: false,
        details: 'Not checked yet',
      });
    }

    return checks;
  }

  public isQuestionOnlyPrompt(prompt: string): boolean {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    const startsWithQuestionWord =
      /^(?:what|why|how|where|when|who|explain|describe|can\s+you\s+explain|tell\s+me|does|is\s+there)\b/i.test(
        trimmed
      );
    const hasMutatingDirective =
      /\b(?:fix|implement|add|create|update|modify|refactor|write|change|delete|remove|patch)\b/i.test(
        trimmed
      );
    return (startsWithQuestionWord || trimmed.endsWith('?')) && !hasMutatingDirective;
  }

  /**
   * Classifies whether a shell command is a verification command (test, build, lint, or reproduction check).
   */
  public classifyVerificationCommand(command: string): EvidenceType | null {
    if (
      this.config.verification.customTestCommand &&
      command.includes(this.config.verification.customTestCommand)
    ) {
      return 'test_execution';
    }
    if (
      this.config.verification.customBuildCommand &&
      command.includes(this.config.verification.customBuildCommand)
    ) {
      return 'build_execution';
    }
    for (const pat of TEST_CMD_PATTERNS) {
      if (pat.test(command)) return 'test_execution';
    }
    for (const pat of BUILD_CMD_PATTERNS) {
      if (pat.test(command)) return 'build_execution';
    }
    for (const pat of LINT_CMD_PATTERNS) {
      if (pat.test(command)) return 'lint_execution';
    }
    if (/\b(?:node|python3?|npx\s+tsx)\s+\S*(?:repro|verify|test|check)\S*/i.test(command)) {
      return 'reproduction_check';
    }
    return null;
  }

  /**
   * Records a verification command outcome into the session state.
   */
  public recordCommandOutcome(
    session: SessionState,
    command: string,
    exitCode: number,
    outputSummary: string
  ): VerificationEvidence | null {
    const evidenceType = this.classifyVerificationCommand(command);
    if (!evidenceType) return null;

    const passed = exitCode === 0;
    const evidence: VerificationEvidence = {
      type: evidenceType,
      command,
      passed,
      exitCode,
      timestamp: new Date().toISOString(),
      stepIndex: session.stepCount,
      summary: outputSummary.slice(0, 300),
      coveredFiles: Object.keys(session.modifiedFiles),
    };

    session.verificationEvidences.push(evidence);
    if (
      passed &&
      (evidenceType === 'test_execution' ||
        evidenceType === 'build_execution' ||
        evidenceType === 'reproduction_check')
    ) {
      session.lastVerificationStep = session.stepCount;
    }
    return evidence;
  }

  /**
   * Evaluates the current session and workspace state to produce a comprehensive VerificationReport
   * distinguishing VERIFIED, FAILED, and NOT_VERIFIED.
   */
  public evaluate(
    session: SessionState,
    lastAssistantMessage?: string,
    userInitiatedStop = false
  ): VerificationReport {
    const allModified = Object.values(session.modifiedFiles);
    const modifiedSourceFiles: string[] = [];
    const modifiedDocOnlyFiles: string[] = [];
    const dirtyFilesSinceLastVerification: string[] = [];
    const commentOnlyModifiedFiles: string[] = [];

    for (const mod of allModified) {
      const ext = path.extname(mod.relativePath).toLowerCase();
      if (DOC_ONLY_EXTENSIONS.has(ext)) {
        modifiedDocOnlyFiles.push(mod.relativePath);
      } else {
        modifiedSourceFiles.push(mod.relativePath);
        if (mod.lastModifiedStep > session.lastVerificationStep) {
          dirtyFilesSinceLastVerification.push(mod.relativePath);
        }
        if (mod.hasSubstantiveCodeChange === false) {
          commentOnlyModifiedFiles.push(mod.relativePath);
        }
      }
    }

    const detectedCommands = this.detectProjectVerificationCommands();
    const hasRunnableSuite = detectedCommands.length > 0;
    const userOptedOut =
      Boolean(session.userOptedOutOfVerification) || userInitiatedStop;

    // Evaluate requirement checks against current workspace files
    const requirementChecks = this.verifyRequirements(
      session.extractedRequirements,
      modifiedSourceFiles
    );
    const failedRequirements = requirementChecks.filter((r) => !r.satisfied);

    const testAndBuildEvidences = session.verificationEvidences.filter(
      (e) =>
        e.type === 'test_execution' ||
        e.type === 'build_execution' ||
        e.type === 'reproduction_check'
    );
    const latestEvidence =
      testAndBuildEvidences.length > 0
        ? testAndBuildEvidences[testAndBuildEvidences.length - 1]
        : undefined;

    // Only flag unsubstantiated test claims if source files were actually modified in this session!
    // Never block a read-only Q&A turn just because the assistant's explanation mentions "tests pass".
    const claimsTestsPassOnModifiedCode =
      modifiedSourceFiles.length > 0 &&
      Boolean(
        lastAssistantMessage &&
          /\b(?:all\s+tests?\s+(?:are\s+)?pass(?:ing|ed)?|verified\s+with\s+tests|tests?\s+succeeded|build\s+succeeded)\b/i.test(
            lastAssistantMessage
          )
      );

    const missingEvidenceReasons: string[] = [];

    // Check if existing tests passed, yet the agent only edited comments/whitespace without substantive code changes
    if (
      modifiedSourceFiles.length > 0 &&
      commentOnlyModifiedFiles.length === modifiedSourceFiles.length &&
      session.initialPrompt &&
      !this.isQuestionOnlyPrompt(session.initialPrompt)
    ) {
      missingEvidenceReasons.push(
        `Modified source file(s) [${commentOnlyModifiedFiles.join(', ')}] contain only comment or whitespace changes; requested code modification is incomplete.`
      );
    }

    // Case 1: Explicit failure evidence (last test/build failed after the latest source edit, required symbols missing, or comment-only sham edit)
    const latestSourceEditStep = allModified.reduce(
      (maxStep, mod) =>
        DOC_ONLY_EXTENSIONS.has(path.extname(mod.relativePath).toLowerCase())
          ? maxStep
          : Math.max(maxStep, mod.lastModifiedStep),
      0
    );
    const hasUnresolvedFailedEvidence = Boolean(
      latestEvidence &&
        !latestEvidence.passed &&
        latestEvidence.stepIndex >= session.lastVerificationStep &&
        latestEvidence.stepIndex >= latestSourceEditStep
    );

    if (hasUnresolvedFailedEvidence && latestEvidence) {
      missingEvidenceReasons.push(
        `Most recent verification command \`${latestEvidence.command}\` failed with exit code ${latestEvidence.exitCode} at step #${latestEvidence.stepIndex}.`
      );
    }

    for (const req of failedRequirements) {
      missingEvidenceReasons.push(
        `Missing requirement: ${req.description} (${req.details}).`
      );
    }

    if (
      hasUnresolvedFailedEvidence ||
      failedRequirements.length > 0 ||
      (modifiedSourceFiles.length > 0 &&
        commentOnlyModifiedFiles.length === modifiedSourceFiles.length &&
        session.initialPrompt &&
        !this.isQuestionOnlyPrompt(session.initialPrompt))
    ) {
      const shouldBlock =
        !userOptedOut &&
        this.config.verification.enabled &&
        this.config.verification.enforceOnStop &&
        session.stopBlockCount < this.config.verification.maxStopBlocksPerSession;

      return {
        status: 'FAILED',
        summary: `Verification FAILED: ${missingEvidenceReasons.join(' ')}`,
        hasRunnableVerificationSuite: hasRunnableSuite,
        userOptedOut,
        modifiedSourceFiles,
        modifiedDocOnlyFiles,
        dirtyFilesSinceLastVerification,
        evidences: session.verificationEvidences,
        requirementChecks,
        missingEvidenceReasons,
        recommendedCommands: detectedCommands,
        shouldBlockStop: shouldBlock,
        stopBlockCount: session.stopBlockCount,
      };
    }

    // Case 2: No source files modified (pure read-only Q&A or documentation-only edits)
    if (modifiedSourceFiles.length === 0) {
      if (
        modifiedDocOnlyFiles.length > 0 &&
        this.config.verification.exemptDocOnlyChanges
      ) {
        return {
          status: 'VERIFIED',
          summary: `VERIFIED (documentation-only changes in ${modifiedDocOnlyFiles.join(', ')}; no code regression risk).`,
          hasRunnableVerificationSuite: hasRunnableSuite,
          userOptedOut,
          modifiedSourceFiles,
          modifiedDocOnlyFiles,
          dirtyFilesSinceLastVerification: [],
          evidences: session.verificationEvidences,
          requirementChecks,
          missingEvidenceReasons: [],
          recommendedCommands: detectedCommands,
          shouldBlockStop: false,
          stopBlockCount: session.stopBlockCount,
        };
      }

      if (testAndBuildEvidences.some((e) => e.passed)) {
        return {
          status: 'VERIFIED',
          summary: `VERIFIED via command execution with no pending dirty files.`,
          hasRunnableVerificationSuite: hasRunnableSuite,
          userOptedOut,
          modifiedSourceFiles,
          modifiedDocOnlyFiles,
          dirtyFilesSinceLastVerification: [],
          evidences: session.verificationEvidences,
          requirementChecks,
          missingEvidenceReasons: [],
          recommendedCommands: detectedCommands,
          shouldBlockStop: false,
          stopBlockCount: session.stopBlockCount,
        };
      }

      return {
        status: 'NOT_VERIFIED',
        summary: `Read-only / informational turn (no source files modified).`,
        hasRunnableVerificationSuite: hasRunnableSuite,
        userOptedOut,
        modifiedSourceFiles,
        modifiedDocOnlyFiles,
        dirtyFilesSinceLastVerification: [],
        evidences: session.verificationEvidences,
        requirementChecks,
        missingEvidenceReasons: [],
        recommendedCommands: detectedCommands,
        shouldBlockStop: false,
        stopBlockCount: session.stopBlockCount,
      };
    }

    // Case 3: Source files modified, but repository has NO configured test or build runner
    if (!hasRunnableSuite && dirtyFilesSinceLastVerification.length > 0) {
      return {
        status: 'NOT_VERIFIED',
        summary: `Task NOT_VERIFIED (no runnable test or build script exists in repository manifests; static requirement checks passed without blocking).`,
        hasRunnableVerificationSuite: false,
        userOptedOut,
        modifiedSourceFiles,
        modifiedDocOnlyFiles,
        dirtyFilesSinceLastVerification,
        evidences: session.verificationEvidences,
        requirementChecks,
        missingEvidenceReasons: [
          'No test or build runner is configured in this repository.',
        ],
        recommendedCommands: [],
        shouldBlockStop: false,
        stopBlockCount: session.stopBlockCount,
      };
    }

    // Case 4: Source files modified since last test/build run in a repo WITH a runnable test/build suite
    if (dirtyFilesSinceLastVerification.length > 0) {
      missingEvidenceReasons.push(
        `Source file(s) [${dirtyFilesSinceLastVerification.join(', ')}] were modified after the last verification run (or no tests/build were executed).`
      );
    }

    if (claimsTestsPassOnModifiedCode && testAndBuildEvidences.length === 0) {
      missingEvidenceReasons.push(
        `Agent response claims tests/build passed, but zero test or build commands were executed in this session.`
      );
    }

    if (missingEvidenceReasons.length > 0) {
      const shouldBlock =
        !userOptedOut &&
        hasRunnableSuite &&
        this.config.verification.enabled &&
        this.config.verification.enforceOnStop &&
        this.config.verification.requireTestsWhenCodeModified &&
        session.stopBlockCount < this.config.verification.maxStopBlocksPerSession;

      return {
        status: 'NOT_VERIFIED',
        summary: `Task NOT_VERIFIED: ${missingEvidenceReasons.join(' ')} Run \`${detectedCommands[0]}\` to verify before completing.`,
        hasRunnableVerificationSuite: hasRunnableSuite,
        userOptedOut,
        modifiedSourceFiles,
        modifiedDocOnlyFiles,
        dirtyFilesSinceLastVerification,
        evidences: session.verificationEvidences,
        requirementChecks,
        missingEvidenceReasons,
        recommendedCommands: detectedCommands,
        shouldBlockStop: shouldBlock,
        stopBlockCount: session.stopBlockCount,
      };
    }

    // Case 5: Source files were modified AND verified after the last edit AND all requirements pass
    return {
      status: 'VERIFIED',
      summary: `VERIFIED: All ${modifiedSourceFiles.length} modified source file(s) tested via \`${latestEvidence?.command ?? 'verification suite'}\` (exit code 0) and ${requirementChecks.length} requirement check(s) passed.`,
      hasRunnableVerificationSuite: hasRunnableSuite,
      userOptedOut,
      modifiedSourceFiles,
      modifiedDocOnlyFiles,
      dirtyFilesSinceLastVerification: [],
      evidences: session.verificationEvidences,
      requirementChecks,
      missingEvidenceReasons: [],
      recommendedCommands: detectedCommands,
      shouldBlockStop: false,
      stopBlockCount: session.stopBlockCount,
    };
  }

  /**
   * Detects the repository's native test and build commands from package.json, pyproject.toml, Cargo.toml, or go.mod.
   * Returns an empty array `[]` if no runnable test or build suite exists in the repository.
   */
  public detectProjectVerificationCommands(): string[] {
    const commands: string[] = [];
    if (this.config.verification.customTestCommand) {
      commands.push(this.config.verification.customTestCommand);
    }
    if (this.config.verification.customBuildCommand) {
      commands.push(this.config.verification.customBuildCommand);
    }

    const pkgJsonPath = path.join(this.cwd, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
          commands.push('npm test');
        }
        if (pkg.scripts?.typecheck) {
          commands.push('npm run typecheck');
        }
        if (pkg.scripts?.build) {
          commands.push('npm run build');
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    if (
      fs.existsSync(path.join(this.cwd, 'pyproject.toml')) ||
      fs.existsSync(path.join(this.cwd, 'pytest.ini'))
    ) {
      commands.push('pytest');
    }
    if (fs.existsSync(path.join(this.cwd, 'Cargo.toml'))) {
      commands.push('cargo test');
    }
    if (fs.existsSync(path.join(this.cwd, 'go.mod'))) {
      commands.push('go test ./...');
    }

    return Array.from(new Set(commands));
  }

  private verifyRequirements(
    requirements: RequirementCheck[],
    modifiedFiles: string[]
  ): RequirementCheck[] {
    if (!requirements || requirements.length === 0) return [];

    return requirements.map((req) => {
      if (req.targetFile) {
        const absTarget = path.resolve(this.cwd, req.targetFile);
        const exists = fs.existsSync(absTarget);
        return {
          ...req,
          satisfied: exists,
          details: exists
            ? `File '${req.targetFile}' exists on disk`
            : `File '${req.targetFile}' does not exist`,
        };
      }

      if (req.requiredSymbolOrPattern) {
        const sym = req.requiredSymbolOrPattern;
        const allFiles = Array.from(
          new Set([...modifiedFiles, ...this.listSourceFilesQuick()])
        );
        for (const rel of allFiles) {
          const abs = path.resolve(this.cwd, rel);
          try {
            const content = fs.readFileSync(abs, 'utf-8');
            // Strip comments before checking if the required symbol is defined/used in executable code
            const codeWithoutComments = this.stripComments(content);
            if (codeWithoutComments.includes(sym)) {
              return {
                ...req,
                satisfied: true,
                details: `Found '${sym}' in executable code of ${rel}`,
              };
            }
          } catch {
            continue;
          }
        }

        return {
          ...req,
          satisfied: false,
          details: `Symbol '${sym}' was not found in executable code of any source file`,
        };
      }

      return { ...req, satisfied: true, details: 'Passed' };
    });
  }

  public stripComments(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*#.*$/gm, '');
  }

  private listSourceFilesQuick(): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (
          e.name === 'node_modules' ||
          e.name === '.git' ||
          e.name === 'dist' ||
          e.name === '.agent-opt'
        ) {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile() && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(e.name)) {
          results.push(path.relative(this.cwd, full).split(path.sep).join('/'));
        }
      }
    };
    walk(this.cwd);
    return results;
  }
}
