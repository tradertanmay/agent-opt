import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CodeSymbol,
  ContextOptimizationResult,
  FileNode,
  OptimizerConfig,
  RankedContextItem,
  SessionState,
  SymbolKind,
} from '../types/index.js';
import { getAgentOptDir } from '../config/index.js';
import { countCalibratedTokens, sha256String } from '../utils/tokens.js';
import {
  isSensitiveFilePath,
  sanitizeContextText,
  writeJsonAtomic,
} from '../security/index.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.agent-opt',
  '.atm',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.cursor',
  '.claude',
  '.agents',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.c',
  '.cpp',
  '.h',
  '.cs',
  '.json',
  '.md',
]);

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'have',
  'are',
  'was',
  'were',
  'will',
  'can',
  'please',
  'make',
  'fix',
  'update',
  'add',
  'remove',
  'change',
  'file',
  'code',
  'function',
  'method',
  'class',
  'bug',
  'issue',
  'error',
  'when',
  'where',
  'what',
  'how',
  'why',
  'into',
  'should',
  'need',
  'ensure',
]);

interface RepoGraphCache {
  version: number;
  files: Record<string, FileNode>;
}

export class ContextOptimizationEngine {
  private cwd: string;
  private config: OptimizerConfig;

  constructor(cwd: string, config: OptimizerConfig) {
    this.cwd = cwd;
    this.config = config;
  }

  /**
   * Builds or incrementally updates the repository structural & dependency graph.
   * Uses content SHA-256 verification so files modified without mtime or size changes
   * are always accurately re-indexed.
   */
  public buildRepoGraph(): Record<string, FileNode> {
    const cachePath = path.join(getAgentOptDir(this.cwd), 'cache', 'repo-graph.json');
    let cachedFiles: Record<string, FileNode> = {};
    if (fs.existsSync(cachePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as RepoGraphCache;
        if (parsed && parsed.version === 1 && parsed.files) {
          cachedFiles = parsed.files;
        }
      } catch {
        cachedFiles = {};
      }
    }

    const discoveredFiles = this.walkWorkspace(this.cwd);
    const currentGraph: Record<string, FileNode> = {};
    let dirty = false;

    for (const absPath of discoveredFiles) {
      const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');
      if (isSensitiveFilePath(relPath)) {
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (stat.size > 512 * 1024) {
        // Skip oversized generated files > 512KB
        continue;
      }

      let content = '';
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const currentSha = sha256String(content);
      const prev = cachedFiles[relPath];
      if (prev && prev.sha256 === currentSha) {
        currentGraph[relPath] = {
          ...prev,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
          importedBy: [],
        };
        continue;
      }

      dirty = true;
      const lines = content.split(/\r?\n/);
      const ext = path.extname(relPath).toLowerCase();
      const symbols = this.extractSymbols(lines, ext);
      const rawImports = this.extractImports(content, ext);
      const resolvedImports = this.resolveImportPaths(relPath, rawImports, discoveredFiles);

      currentGraph[relPath] = {
        relativePath: relPath,
        absolutePath: absPath,
        sizeBytes: stat.size,
        lineCount: lines.length,
        sha256: currentSha,
        mtimeMs: stat.mtimeMs,
        language: ext.replace(/^\./, '') || 'text',
        imports: resolvedImports,
        importedBy: [],
        symbols,
        centralityScore: 1.0,
      };
    }

    // Populate reverse dependency edges (importedBy) and centrality score
    for (const fileNode of Object.values(currentGraph)) {
      for (const imp of fileNode.imports) {
        if (currentGraph[imp]) {
          currentGraph[imp].importedBy.push(fileNode.relativePath);
        }
      }
    }

    for (const fileNode of Object.values(currentGraph)) {
      const inDegree = fileNode.importedBy.length;
      const outDegree = fileNode.imports.length;
      fileNode.centralityScore = Number((1 + inDegree * 0.6 + outDegree * 0.2).toFixed(2));
    }

    if (dirty || Object.keys(cachedFiles).length !== Object.keys(currentGraph).length) {
      try {
        writeJsonAtomic(cachePath, { version: 1, files: currentGraph });
      } catch {
        // Non-fatal if workspace is read-only
      }
    }

    return currentGraph;
  }

  /**
   * Ranks repository files and symbols for a specific user prompt or task query,
   * propagating relevance across 1-hop dependency edges and selecting tight symbol line ranges.
   */
  public optimizeForQuery(
    query: string,
    session?: SessionState
  ): ContextOptimizationResult {
    const graph = this.buildRepoGraph();
    const allNodes = Object.values(graph);
    const fullRepoTokenCount = allNodes.reduce(
      (acc, node) => acc + Math.ceil(node.sizeBytes / 3.8),
      0
    );

    const queryTerms = this.tokenizeQuery(query);
    if (
      this.config.context.minQuerySpecificityForInjection &&
      queryTerms.length === 0 &&
      query.trim().length < 15
    ) {
      return {
        query,
        rankedFiles: [],
        compactRepoMap: '',
        injectedTokenCount: 0,
        fullRepoTokenCount,
        estimatedTokensSaved: 0,
        skippedLowRelevanceQuery: true,
      };
    }

    const rawScores: Record<
      string,
      { score: number; reasons: Set<string>; matchedSymbols: CodeSymbol[] }
    > = {};

    for (const node of allNodes) {
      rawScores[node.relativePath] = {
        score: 0,
        reasons: new Set<string>(),
        matchedSymbols: [],
      };
    }

    // Direct lexical + path + symbol matching
    const queryLower = query.toLowerCase();
    for (const node of allNodes) {
      const entry = rawScores[node.relativePath];
      const relLower = node.relativePath.toLowerCase();
      const baseName = path.basename(relLower, path.extname(relLower));

      // Exact relative path mention in query, or specific filename mention
      const hasExplicitRelPath = queryLower.includes(relLower);
      const baseNameWordRegex =
        baseName.length >= 3
          ? new RegExp(`\\b${baseName.replace(/[^a-z0-9]/g, '')}\\b`, 'i')
          : null;
      const isGenericUtilityPath =
        /^src\/(?:core|utils|http|metrics|storage)\//i.test(node.relativePath);
      if (
        hasExplicitRelPath ||
        (baseNameWordRegex &&
          baseNameWordRegex.test(queryLower) &&
          (!isGenericUtilityPath || baseName.length >= 6))
      ) {
        entry.score += 12.0;
        entry.reasons.add(`path match (${node.relativePath})`);
      }

      // Check term overlap with path tokens
      const pathTokens = this.splitIdentifier(node.relativePath);
      for (const qTerm of queryTerms) {
        if (pathTokens.includes(qTerm)) {
          entry.score += isGenericUtilityPath ? 2.0 : 4.5;
          entry.reasons.add(`file keyword '${qTerm}'`);
        }
      }

      // Check symbol matches
      for (const sym of node.symbols) {
        const symLower = sym.name.toLowerCase();
        const symTokens = this.splitIdentifier(sym.name);
        let symMatched = false;

        if (symLower.length > 2 && queryLower.includes(symLower)) {
          entry.score += 10.0;
          entry.reasons.add(`symbol '${sym.name}' (L${sym.line}-${sym.endLine})`);
          symMatched = true;
        } else {
          for (const qTerm of queryTerms) {
            if (symTokens.includes(qTerm)) {
              entry.score += 3.5;
              entry.reasons.add(`symbol keyword '${sym.name}'`);
              symMatched = true;
            }
          }
        }

        if (symMatched) {
          entry.matchedSymbols.push(sym);
        }
      }

      // Boost recently modified files in the same session
      if (session && session.modifiedFiles[node.relativePath]) {
        entry.score += 4.0;
        entry.reasons.add('modified in active session');
      }
    }

    // 1-Hop Dependency Graph Propagation:
    // If file A strongly matches the query, its direct imports and importers receive propagated weight
    const propagatedBonus: Record<string, { bonus: number; via: string[] }> = {};
    for (const node of allNodes) {
      const directScore = rawScores[node.relativePath].score;
      if (directScore >= 6.0) {
        for (const dep of node.imports) {
          if (rawScores[dep]) {
            propagatedBonus[dep] = propagatedBonus[dep] ?? { bonus: 0, via: [] };
            propagatedBonus[dep].bonus += directScore * 0.35;
            propagatedBonus[dep].via.push(`imported by ${node.relativePath}`);
          }
        }
        for (const caller of node.importedBy) {
          if (rawScores[caller]) {
            propagatedBonus[caller] = propagatedBonus[caller] ?? { bonus: 0, via: [] };
            propagatedBonus[caller].bonus += directScore * 0.25;
            propagatedBonus[caller].via.push(`imports ${node.relativePath}`);
          }
        }
      }
    }

    for (const [relPath, prop] of Object.entries(propagatedBonus)) {
      rawScores[relPath].score += Math.min(8.0, prop.bonus);
      rawScores[relPath].reasons.add(prop.via[0]);
    }

    // Rank and select top K files
    const rankedFiles: RankedContextItem[] = [];
    for (const node of allNodes) {
      const entry = rawScores[node.relativePath];
      // Apply mild structural centrality tie-breaker
      const finalScore =
        entry.score > 0
          ? Number((entry.score + node.centralityScore * 0.35).toFixed(2))
          : 0;

      if (finalScore <= 0) continue;

      const relevantSymbols =
        entry.matchedSymbols.length > 0
          ? entry.matchedSymbols.slice(0, 6)
          : node.symbols.filter((s) => s.exported).slice(0, 5);

      let suggestedLineRange: { start: number; end: number } | undefined;
      if (entry.matchedSymbols.length > 0) {
        const minLine = Math.max(
          1,
          Math.min(...entry.matchedSymbols.map((s) => s.line)) - 3
        );
        const maxLine = Math.min(
          node.lineCount,
          Math.max(...entry.matchedSymbols.map((s) => s.endLine)) + 5
        );
        if (maxLine - minLine + 1 < node.lineCount * 0.75) {
          suggestedLineRange = { start: minLine, end: maxLine };
        }
      }

      const estimatedFullTokens = Math.max(10, Math.ceil(node.sizeBytes / 3.8));
      const estimatedSliceTokens = suggestedLineRange
        ? Math.max(
            10,
            Math.ceil(
              ((suggestedLineRange.end - suggestedLineRange.start + 1) /
                Math.max(1, node.lineCount)) *
                estimatedFullTokens
            )
          )
        : estimatedFullTokens;

      rankedFiles.push({
        relativePath: node.relativePath,
        score: finalScore,
        reasons: Array.from(entry.reasons),
        relevantSymbols,
        suggestedLineRange,
        estimatedFullTokens,
        estimatedSliceTokens,
      });
    }

    rankedFiles.sort((a, b) => b.score - a.score);
    const topRanked = rankedFiles.slice(0, this.config.context.maxRankedFiles);

    const compactRepoMap = this.formatCompactRepoMap(topRanked, graph);
    const injectedTokenCount = countCalibratedTokens(compactRepoMap);

    // Estimated tokens saved = difference between blind multi-file exploration of non-ranked files
    // + full file reads vs targeted slice reads on top-ranked files.
    const unrankedExplorationTokens = allNodes
      .filter((n) => !topRanked.some((r) => r.relativePath === n.relativePath))
      .reduce((acc, n) => acc + Math.ceil(n.sizeBytes / 3.8), 0);
    const sliceSavings = topRanked.reduce(
      (acc, r) => acc + Math.max(0, r.estimatedFullTokens - r.estimatedSliceTokens),
      0
    );
    const estimatedTokensSaved = Math.max(
      0,
      Math.round(unrankedExplorationTokens * 0.5 + sliceSavings - injectedTokenCount)
    );

    return {
      query,
      rankedFiles: topRanked,
      compactRepoMap,
      injectedTokenCount,
      fullRepoTokenCount,
      estimatedTokensSaved,
    };
  }

  /**
   * Evaluates whether a requested file read is redundant (already read in this session with identical SHA-256).
   * Safety rules:
   * 1. Never blocks targeted line-range reads or files modified since the last read.
   * 2. Never blocks a re-read if the agent performed other tool operations in between (e.g., read or edited
   *    another file and legitimately needs to re-inspect this file before editing).
   * 3. Only blocks when the agent is executing back-to-back consecutive reads on the exact same unchanged file.
   */
  public evaluateFileRead(
    filePath: string,
    hasExplicitLineRange: boolean,
    session: SessionState
  ): {
    isRedundant: boolean;
    shouldBlock: boolean;
    feedback?: string;
    tokensSaved: number;
  } {
    if (!this.config.context.enabled || !this.config.context.deduplicateReads) {
      return { isRedundant: false, shouldBlock: false, tokensSaved: 0 };
    }

    const normalizedFilePath = filePath.replace(/\\/g, '/');
    const absPath = path.isAbsolute(normalizedFilePath)
      ? normalizedFilePath
      : path.resolve(this.cwd, normalizedFilePath);
    const relPath = path.relative(this.cwd, absPath).split(path.sep).join('/');

    if (!fs.existsSync(absPath)) {
      return { isRedundant: false, shouldBlock: false, tokensSaved: 0 };
    }

    let currentContent = '';
    try {
      currentContent = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return { isRedundant: false, shouldBlock: false, tokensSaved: 0 };
    }

    const currentSha = sha256String(currentContent);
    const existingRecord = session.fileReads[relPath];

    if (!existingRecord || existingRecord.sha256AtRead !== currentSha) {
      return { isRedundant: false, shouldBlock: false, tokensSaved: 0 };
    }

    // If the agent is requesting a specific line slice, allow it (never block precision inspection)
    if (hasExplicitLineRange) {
      return { isRedundant: false, shouldBlock: false, tokensSaved: 0 };
    }

    // If the agent performed other tool calls on different files since reading this file,
    // allow the reread so we NEVER suppress needed file contents before an edit!
    const isImmediateConsecutiveRepeat =
      existingRecord.lastReadStep === session.stepCount &&
      (!session.lastToolTargetFile || session.lastToolTargetFile === relPath);

    if (!isImmediateConsecutiveRepeat) {
      return {
        isRedundant: true,
        shouldBlock: false,
        tokensSaved: 0,
        feedback: `[AgentOpt Note] '${relPath}' is unchanged since step #${existingRecord.lastReadStep}.`,
      };
    }

    const nextConsecutiveCount = (existingRecord.consecutiveReads ?? 1) + 1;
    const fileTokens = countCalibratedTokens(currentContent);
    const graph = this.buildRepoGraph();
    const symbolSummary = (graph[relPath]?.symbols ?? [])
      .map((s) => `${s.kind} ${s.name} (L${s.line}-${s.endLine})`)
      .slice(0, 8)
      .join(', ');

    if (nextConsecutiveCount >= this.config.context.blockRedundantFullReadsAfter) {
      return {
        isRedundant: true,
        shouldBlock: true,
        tokensSaved: fileTokens,
        feedback:
          `[AgentOpt Context Cache] '${relPath}' (SHA-256: ${currentSha.slice(0, 8)}) has already been read in step #${existingRecord.lastReadStep} and has NOT been modified on disk. ` +
          (symbolSummary ? `Indexed symbols: ${symbolSummary}. ` : '') +
          `Reuse the content already in context, or request a specific line range if you need to inspect a particular section.`,
      };
    }

    return {
      isRedundant: true,
      shouldBlock: false,
      tokensSaved: 0,
      feedback: `[AgentOpt Note] '${relPath}' is unchanged since step #${existingRecord.lastReadStep}.`,
    };
  }

  private formatCompactRepoMap(
    rankedFiles: RankedContextItem[],
    graph: Record<string, FileNode>
  ): string {
    if (rankedFiles.length === 0) return '';

    const topScore = rankedFiles[0].score;
    const topPath = rankedFiles[0].relativePath;
    const topNode = graph[topPath];

    const hasImplFile = rankedFiles.some(
      (f) =>
        !f.relativePath.startsWith('test/') &&
        !f.relativePath.includes('.test.') &&
        f.relativePath !== 'package.json' &&
        f.relativePath !== 'README.md'
    );

    const prunedForMap = rankedFiles.filter((item, idx) => {
      if (idx === 0) return true;
      if (
        hasImplFile &&
        (item.relativePath.startsWith('test/') ||
          item.relativePath.includes('.test.') ||
          item.relativePath === 'package.json' ||
          item.relativePath === 'README.md')
      ) {
        return false;
      }
      const isDirectNeighborOfTop = Boolean(
        topNode &&
          (topNode.imports.includes(item.relativePath) ||
            topNode.importedBy.includes(item.relativePath))
      );
      if (isDirectNeighborOfTop && item.score >= topScore * 0.2) {
        return true;
      }
      return item.score >= topScore * 0.45 && item.relevantSymbols.length > 0;
    });

    const displayFiles = prunedForMap.length > 0 ? prunedForMap : rankedFiles.slice(0, 1);

    const lines: string[] = [
      '[AgentOpt Context Map — Ranked Relevant Files & Symbols]',
    ];

    for (let i = 0; i < displayFiles.length; i++) {
      const item = displayFiles[i];
      const node = graph[item.relativePath];
      const rangeHint = item.suggestedLineRange
        ? ` [target slice: L${item.suggestedLineRange.start}-${item.suggestedLineRange.end}]`
        : ` (${node?.lineCount ?? 0} lines)`;
      const symText =
        item.relevantSymbols.length > 0
          ? item.relevantSymbols
              .map((s) => `${s.name}@L${s.line}-${s.endLine}`)
              .join(', ')
          : 'module';
      const depsText =
        node && node.imports.length > 0
          ? ` -> imports: ${node.imports.slice(0, 3).join(', ')}`
          : '';
      lines.push(
        `${i + 1}. ${item.relativePath}${rangeHint} | symbols: ${symText}${depsText}`
      );
    }

    // For top-ranked non-test files with compact target slices, include an inline preview
    // bounded strictly by maxRepoMapTokens so the agent can edit directly without blind directory scans.
    const maxTokens = this.config.context.maxRepoMapTokens ?? 650;
    let currentMap = lines.join('\n');
    let previewedCount = 0;
    let firstPreviewedPath: string | null = null;

    for (const item of displayFiles) {
      if (previewedCount >= 2) break;
      if (item.relativePath.startsWith('test/') || item.relativePath.includes('.test.')) {
        continue;
      }
      if (isSensitiveFilePath(item.relativePath)) continue;

      if (previewedCount === 1 && firstPreviewedPath) {
        const firstNode = graph[firstPreviewedPath];
        const isConnectedMultiFile = Boolean(
          firstNode &&
            (firstNode.imports.includes(item.relativePath) ||
              firstNode.importedBy.includes(item.relativePath))
        );
        const isStrongCoTarget =
          item.score >= topScore * 0.65 && item.relevantSymbols.length > 0;
        if (!isConnectedMultiFile && !isStrongCoTarget) {
          continue;
        }
      }

      const absPath = path.join(this.cwd, item.relativePath);
      try {
        const raw = fs.readFileSync(absPath, 'utf-8');
        const allLines = raw.split(/\r?\n/);
        const startLine = 1;
        const endLine = Math.min(allLines.length, 50);
        if (allLines.length > 50) continue;
        const sliceContent = allLines.slice(startLine - 1, endLine).join('\n');
        const candidateBlock = `\n[Complete Current File: ${item.relativePath} (L1-${endLine}) — verify variable values and recursion before calling write_file]\n\`\`\`js\n${sliceContent}\n\`\`\``;
        if (countCalibratedTokens(currentMap + candidateBlock) <= maxTokens) {
          currentMap += candidateBlock;
          previewedCount += 1;
          if (!firstPreviewedPath) {
            firstPreviewedPath = item.relativePath;
          }
        }
      } catch {
        // ignore read error
      }
    }

    return sanitizeContextText(currentMap).sanitized;
  }

  /**
   * Builds a compact repository symbol overview for platforms (such as Cursor Agent)
   * where `sessionStart` `additional_context` is injected into the initial RequestContext.
   */
  public buildSessionStartOverview(): string {
    const graph = this.buildRepoGraph();
    const nodes = Object.values(graph)
      .filter(
        (n) =>
          !n.relativePath.startsWith('test/') &&
          !n.relativePath.includes('.test.') &&
          n.relativePath !== 'package.json' &&
          !isSensitiveFilePath(n.relativePath)
      )
      .sort((a, b) => b.centralityScore - a.centralityScore || a.relativePath.localeCompare(b.relativePath))
      .slice(0, 12);

    if (nodes.length === 0) return '';

    const lines: string[] = [
      '[AgentOpt Repository Symbol Map — Exact File & Symbol Locations (Read/Edit target files directly without running Glob/Grep first)]',
    ];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const symText =
        node.symbols.length > 0
          ? node.symbols
              .slice(0, 6)
              .map((s) => `${s.name}@L${s.line}-${s.endLine}`)
              .join(', ')
          : 'module';
      const depsText =
        node.imports.length > 0 ? ` -> imports: ${node.imports.slice(0, 3).join(', ')}` : '';
      lines.push(
        `${i + 1}. ${node.relativePath} (${node.lineCount} lines) | symbols: ${symText}${depsText}`
      );
    }

    return sanitizeContextText(lines.join('\n')).sanitized;
  }

  private walkWorkspace(dir: string, acc: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return acc;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkWorkspace(fullPath, acc);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          acc.push(fullPath);
        }
      }
    }
    return acc;
  }

  private extractSymbols(lines: string[], ext: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const total = lines.length;

    const patterns: Array<{ regex: RegExp; kind: SymbolKind; exported?: boolean }> =
      ext === '.py'
        ? [
            { regex: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: 'function', exported: true },
            { regex: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: 'class', exported: true },
          ]
        : [
            {
              regex: /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
              kind: 'function',
            },
            {
              regex: /^\s*(export\s+)?(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
              kind: 'class',
            },
            {
              regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
              kind: 'interface',
            },
            {
              regex: /^\s*(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
              kind: 'type',
            },
            {
              regex: /^\s*(export\s+)const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/,
              kind: 'const',
            },
            {
              regex:
                /^\s+(?:(public|private|protected)\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;]*\)\s*(?::\s*[^{]+)?\{/,
              kind: 'method',
              exported: true,
            },
          ];

    const controlKeywords = new Set([
      'if',
      'for',
      'while',
      'switch',
      'catch',
      'constructor',
      'return',
    ]);

    for (let i = 0; i < total; i++) {
      const line = lines[i];
      for (const pat of patterns) {
        const match = line.match(pat.regex);
        if (match) {
          const name = match[match.length - 1];
          if (pat.kind === 'method' && controlKeywords.has(name)) {
            continue;
          }
          const isExported =
            pat.exported ??
            Boolean(match[1]?.includes('export') || match[1]?.includes('public'));
          const endLine = this.estimateBlockEndLine(lines, i, ext);
          symbols.push({
            name,
            kind: pat.kind,
            line: i + 1,
            endLine,
            exported: isExported,
            signature: line.trim().replace(/\s*\{$/, ''),
          });
          break;
        }
      }
    }

    return symbols;
  }

  private estimateBlockEndLine(lines: string[], startIndex: number, ext: string): number {
    if (ext === '.py') {
      const startIndent = lines[startIndex].search(/\S|$/);
      for (let i = startIndex + 1; i < Math.min(lines.length, startIndex + 120); i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = lines[i].search(/\S|$/);
        if (indent <= startIndent) {
          return i;
        }
      }
      return Math.min(lines.length, startIndex + 25);
    }

    let braceDepth = 0;
    let sawOpeningBrace = false;
    for (let i = startIndex; i < Math.min(lines.length, startIndex + 150); i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') {
          braceDepth++;
          sawOpeningBrace = true;
        } else if (ch === '}') {
          braceDepth--;
          if (sawOpeningBrace && braceDepth <= 0) {
            return i + 1;
          }
        }
      }
    }
    return Math.min(lines.length, startIndex + 20);
  }

  private extractImports(content: string, ext: string): string[] {
    const imports: string[] = [];
    if (ext === '.py') {
      const pyRegex = /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm;
      let m: RegExpExecArray | null;
      while ((m = pyRegex.exec(content)) !== null) {
        const target = m[1] || m[2];
        if (target) imports.push(target);
      }
      return imports;
    }

    const importRegex =
      /(?:import\s+[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const spec = m[1] || m[2] || m[3];
      if (spec && spec.startsWith('.')) {
        imports.push(spec);
      }
    }
    return imports;
  }

  private resolveImportPaths(
    importerRelPath: string,
    rawImports: string[],
    allAbsFiles: string[]
  ): string[] {
    const relSet = new Set(
      allAbsFiles.map((abs) => path.relative(this.cwd, abs).split(path.sep).join('/'))
    );
    const importerDir = path.posix.dirname(importerRelPath);
    const resolved: string[] = [];

    for (const raw of rawImports) {
      if (!raw.startsWith('.')) continue;
      const baseCandidate = path.posix.normalize(path.posix.join(importerDir, raw));
      const withoutJsExt = baseCandidate.replace(/\.(js|mjs|cjs)$/, '');
      const candidates = [
        baseCandidate,
        `${withoutJsExt}.ts`,
        `${withoutJsExt}.tsx`,
        `${withoutJsExt}.js`,
        `${withoutJsExt}/index.ts`,
        `${withoutJsExt}/index.js`,
      ];
      for (const cand of candidates) {
        if (relSet.has(cand)) {
          resolved.push(cand);
          break;
        }
      }
    }

    return Array.from(new Set(resolved));
  }

  private tokenizeQuery(query: string): string[] {
    const rawTokens = this.splitIdentifier(query);
    return Array.from(
      new Set(
        rawTokens.filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t))
      )
    );
  }

  private splitIdentifier(input: string): string[] {
    const expanded = input
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./:\\]+/g, ' ');
    const words = expanded.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return words;
  }
}
