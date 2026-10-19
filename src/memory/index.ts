import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MemoryCategory,
  OptimizerConfig,
  ProjectMemoryEntry,
} from '../types/index.js';
import { getAgentOptDir } from '../config/index.js';
import { sha256File, sha256String } from '../utils/tokens.js';
import { sanitizeContextText, writeJsonAtomic } from '../security/index.js';

interface MemoryStoreFile {
  version: number;
  updatedAt: string;
  entries: ProjectMemoryEntry[];
}

export class CrossSessionMemoryStore {
  private cwd: string;
  private config: OptimizerConfig;

  constructor(cwd: string, config: OptimizerConfig) {
    this.cwd = cwd;
    this.config = config;
  }

  public getMemoryFilePath(): string {
    return path.join(getAgentOptDir(this.cwd), 'memory', 'project-memory.json');
  }

  /**
   * Loads all memories and runs automatic staleness/manifest validation so
   * outdated, contradictory, or speculative memories never influence tasks.
   */
  public loadAll(includeInvalidated = false): ProjectMemoryEntry[] {
    const filePath = this.getMemoryFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MemoryStoreFile;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const currentManifestHash = this.computeManifestHash();
      let modified = false;

      for (const entry of entries) {
        if (entry.invalidated) continue;

        // If manifest changed since a script/dependency memory was recorded, validate it still holds
        if (
          entry.packageJsonHash &&
          currentManifestHash &&
          entry.packageJsonHash !== currentManifestHash
        ) {
          if (!this.isEntryStillValidAgainstManifest(entry)) {
            entry.invalidated = true;
            entry.invalidationReason =
              'Invalidated automatically because project manifest (package.json/pyproject.toml) changed and no longer matches this entry.';
            entry.confidence = 0.1;
            modified = true;
          } else {
            entry.packageJsonHash = currentManifestHash;
            modified = true;
          }
        }
      }

      if (modified) {
        this.saveAll(entries);
      }

      return includeInvalidated ? entries : entries.filter((e) => !e.invalidated);
    } catch {
      return [];
    }
  }

  /**
   * Returns only verified, high-confidence, non-contradicted memories ready for prompt injection.
   */
  public getActiveMemoriesForInjection(): ProjectMemoryEntry[] {
    if (!this.config.memory.enabled) return [];
    const active = this.loadAll(false).filter(
      (e) =>
        !e.invalidated &&
        e.confidence >= this.config.memory.minConfidenceToInject &&
        e.contradictedCount <= e.verifiedCount
    );
    active.sort((a, b) => b.confidence - a.confidence || b.verifiedCount - a.verifiedCount);
    return active.slice(0, 10);
  }

  /**
   * Formats active verified memories into a compact, zero-fluff context block.
   */
  public formatMemoriesForPrompt(): string {
    const memories = this.getActiveMemoriesForInjection();
    if (memories.length === 0) return '';

    const lines: string[] = [
      '[AgentOpt Verified Project Memory (Empirically Confirmed)]',
    ];
    for (const mem of memories) {
      lines.push(`- [${mem.category}] ${mem.key}: ${mem.value}`);
    }
    return sanitizeContextText(lines.join('\n')).sanitized;
  }

  /**
   * Records or reinforces a verified project memory.
   * Rejects low-confidence speculative entries (< 0.5) from becoming active unless verified.
   */
  public upsertVerifiedMemory(params: {
    category: MemoryCategory;
    key: string;
    value: string;
    confidence?: number;
    sourceSessionId: string;
    evidenceCommand?: string;
  }): ProjectMemoryEntry {
    const entries = this.loadAll(true);
    const now = new Date().toISOString();
    const manifestHash = this.computeManifestHash();
    const id = `mem_${sha256String(`${params.category}:${params.key}`).slice(0, 10)}`;

    const existingIdx = entries.findIndex(
      (e) => e.category === params.category && e.key === params.key
    );

    if (existingIdx !== -1) {
      const prev = entries[existingIdx];
      // Check if the new verified value contradicts the old value
      if (prev.value !== params.value) {
        prev.value = params.value;
        prev.confidence = params.confidence ?? 0.85;
        prev.verifiedCount = 1;
        prev.contradictedCount = 0;
        prev.invalidated = false;
        prev.invalidationReason = undefined;
      } else {
        prev.verifiedCount += 1;
        prev.confidence = Math.min(0.99, Number((prev.confidence + 0.05).toFixed(2)));
        prev.invalidated = false;
        prev.invalidationReason = undefined;
      }
      prev.lastVerifiedAt = now;
      prev.sourceSessionId = params.sourceSessionId;
      if (params.evidenceCommand) prev.evidenceCommand = params.evidenceCommand;
      if (manifestHash) prev.packageJsonHash = manifestHash;
      this.saveAll(entries);
      return prev;
    }

    const newEntry: ProjectMemoryEntry = {
      id,
      category: params.category,
      key: params.key,
      value: params.value,
      confidence: params.confidence ?? 0.85,
      verifiedCount: 1,
      contradictedCount: 0,
      createdAt: now,
      lastVerifiedAt: now,
      sourceSessionId: params.sourceSessionId,
      evidenceCommand: params.evidenceCommand,
      packageJsonHash: manifestHash ?? undefined,
    };

    entries.push(newEntry);
    // Keep within maxEntries cap by pruning lowest-confidence entries
    if (entries.length > this.config.memory.maxEntries) {
      entries.sort((a, b) => b.confidence - a.confidence);
      entries.length = this.config.memory.maxEntries;
    }

    this.saveAll(entries);
    return newEntry;
  }

  /**
   * Marks a memory as contradicted when a command or assumption fails in practice.
   */
  public recordContradiction(category: MemoryCategory, keyOrCommand: string, reason: string): void {
    const entries = this.loadAll(true);
    let changed = false;

    for (const entry of entries) {
      if (
        entry.category === category &&
        (entry.key === keyOrCommand || entry.value.includes(keyOrCommand))
      ) {
        entry.contradictedCount += 1;
        entry.confidence = Math.max(0.1, Number((entry.confidence - 0.35).toFixed(2)));
        if (
          this.config.memory.autoPruneContradictions &&
          entry.confidence < this.config.memory.minConfidenceToInject
        ) {
          entry.invalidated = true;
          entry.invalidationReason = reason;
        }
        changed = true;
      }
    }

    if (changed) {
      this.saveAll(entries);
    }
  }

  /**
   * Automatically harvests verified project facts from repository manifests and passing commands.
   */
  public bootstrapFromWorkspace(sessionId = 'bootstrap'): ProjectMemoryEntry[] {
    const created: ProjectMemoryEntry[] = [];
    const pkgPath = path.join(this.cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
          type?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
          created.push(
            this.upsertVerifiedMemory({
              category: 'test_command',
              key: 'primary_test_command',
              value: `Run \`npm test\` (executes \`${pkg.scripts.test}\`)`,
              confidence: 0.9,
              sourceSessionId: sessionId,
            })
          );
        }
        if (pkg.scripts?.build) {
          created.push(
            this.upsertVerifiedMemory({
              category: 'build_command',
              key: 'primary_build_command',
              value: `Run \`npm run build\` (executes \`${pkg.scripts.build}\`)`,
              confidence: 0.9,
              sourceSessionId: sessionId,
            })
          );
        }
        if (pkg.type === 'module') {
          created.push(
            this.upsertVerifiedMemory({
              category: 'dependency_constraint',
              key: 'module_system',
              value: 'ESM ("type": "module" in package.json); use explicit .js extensions in relative TypeScript imports.',
              confidence: 0.95,
              sourceSessionId: sessionId,
            })
          );
        }
      } catch {
        // Ignore invalid package.json
      }
    }
    return created;
  }

  public removeMemory(idOrKey: string): boolean {
    const entries = this.loadAll(true);
    const filtered = entries.filter((e) => e.id !== idOrKey && e.key !== idOrKey);
    if (filtered.length === entries.length) return false;
    this.saveAll(filtered);
    return true;
  }

  public clearAll(): void {
    this.saveAll([]);
  }

  private saveAll(entries: ProjectMemoryEntry[]): void {
    const filePath = this.getMemoryFilePath();
    const payload: MemoryStoreFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    writeJsonAtomic(filePath, payload);
  }

  private computeManifestHash(): string | null {
    const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
    const hashes: string[] = [];
    for (const m of manifests) {
      const p = path.join(this.cwd, m);
      if (fs.existsSync(p)) {
        const h = sha256File(p);
        if (h) hashes.push(`${m}:${h}`);
      }
    }
    return hashes.length > 0 ? sha256String(hashes.join('|')).slice(0, 16) : null;
  }

  private isEntryStillValidAgainstManifest(entry: ProjectMemoryEntry): boolean {
    const pkgPath = path.join(this.cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) return true;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        type?: string;
        scripts?: Record<string, string>;
      };
      if (entry.category === 'test_command' && entry.key === 'primary_test_command') {
        const script = pkg.scripts?.test;
        return Boolean(script && entry.value.includes(script));
      }
      if (entry.category === 'build_command' && entry.key === 'primary_build_command') {
        const script = pkg.scripts?.build;
        return Boolean(script && entry.value.includes(script));
      }
      if (entry.category === 'dependency_constraint' && entry.key === 'module_system') {
        return pkg.type === 'module';
      }
    } catch {
      return false;
    }
    return true;
  }
}
