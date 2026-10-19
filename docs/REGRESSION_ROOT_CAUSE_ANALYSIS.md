# Root-Cause Analysis of Observed Correctness Regressions (`task_01` & `task_03`)

## Executive Summary

During the initial 30-task real-LLM evaluation (`qwen2.5:7b` via Ollama `/api/chat` at `temperature = 0`), two tasks exhibited a correctness regression where the unassisted `baseline` agent passed the held-out oracle test suite (`heldOutOraclePassed = true`) while `context-only` and `full-agent-opt` failed (`heldOutOraclePassed = false`):

1. **`task_01_lru_eviction`** (*Fix `LRUCache.get` recency refresh order in `src/cache/lru.mjs`*)
2. **`task_03_deep_freeze_array`** (*Preserve and recursively clone nested arrays in `deepCloneConfig` in `src/config/clone.mjs`*)

Rather than weakening any acceptance or oracle test, we inspected the exact Turn-by-Turn tool-call trajectories, injected `UserPromptSubmit` context payloads, and `Stop`-hook continuation messages for both tasks. Below is the complete forensic analysis, exact first point of divergence, root-cause classification, code fix, and post-fix verification across `FAST`, `BALANCED`, and `STRICT` modes.

---

## Regression 1: `task_01_lru_eviction`

### 1.1 Task Specification & Initial Code

- **Discovery Prompt:**
  > Fix the bug where `LRUCache.get(key)` returns the cached value but forgets to refresh the key as most-recently-used before future `set` evictions.
- **Target File (`src/cache/lru.mjs`):**
  ```js
  export class LRUCache {
    constructor(capacity = 3) {
      this.capacity = capacity;
      this.map = new Map();
    }

    get(key) {
      if (!this.map.has(key)) return undefined;
      return this.map.get(key);
    }

    set(key, value) {
      if (this.map.has(key)) {
        this.map.delete(key);
      } else if (this.map.size >= this.capacity) {
        const oldestKey = this.map.keys().next().value;
        this.map.delete(oldestKey);
      }
      this.map.set(key, value);
    }
  }
  ```

### 1.2 Pre-Fix Trajectory Comparison

| Condition | Turn-by-Turn Tool Trajectory | Workspace Tests (`ws`) | Held-Out Oracle (`ora`) | Input Tokens | Output Tokens |
|---|---|---|---|---:|---:|
| `baseline` | `list_files(11) -> read_file(src/cache/lru.mjs) -> write_file(src/cache/lru.mjs) -> run_command(npm test:exit=0) -> finish_task` | `true` | `true` | `4,014` | `417` |
| `context-only` (pre-fix) | `write_file(src/cache/lru.mjs) -> finish_task` | `false` | `false` | `1,879` | `238` |
| `full-agent-opt` (pre-fix) | `write_file(src/cache/lru.mjs) -> StopBlocked(NOT_VERIFIED) -> write_file(src/cache/lru.mjs) -> run_command(npm test:exit=1) -> StopBlocked(FAILED)` | `false` | `false` | `7,307` | `754` |

### 1.3 First Meaningful Divergence

The divergence occurred on **Turn 1** inside the `write_file("src/cache/lru.mjs")` call:

- **What `baseline` wrote (after calling `read_file("src/cache/lru.mjs")` in its own turn):**
  ```js
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  ```
- **What `context-only` and `full-agent-opt` wrote on Turn 1:**
  ```js
  get(key) {
    if (!this.map.has(key)) return undefined;
    this.map.delete(key);
    this.map.set(key, this.map.get(key)); // BUG: this.map.get(key) is undefined AFTER delete(key)!
    return this.map.get(key);
  }
  ```

### 1.4 Root-Cause Determination

1. **Did context pruning remove critical information?**
   - **No — the opposite occurred (Distractor Pollution + Missing ES6 Method Indexing):**
     - In [`src/context/index.ts`](../src/context/index.ts), `extractSymbols` required a TypeScript visibility modifier (`public|private|protected`) on class methods (`^\s*(?:(public|private|protected)\s+)...`), so standard JavaScript ES6 class methods `get(key)` and `set(key, value)` inside `src/cache/lru.mjs` were not indexed as symbols.
     - Worse, `formatCompactRepoMap` did not prune low-scoring distractor files before inlining up to 2 `[Complete Current File]` blocks. Because the distractor file `src/core/env.mjs` exported `getEnvVar(key, fallback)` (matching the query token `get`), `formatCompactRepoMap` injected **two** full files into Turn 1: `src/cache/lru.mjs` (`score: 22.56`) AND the unrelated distractor `src/core/env.mjs` (`score: 3.85`), alongside a coercive instruction (`"edit it directly with write_file without calling read_file first"`).
2. **Did verification cause harmful actions?**
   - **Verification in `full-agent-opt` failed to help the model recover and burned 5,428 extra input tokens:**
     - When the agent called `finish_task` on Turn 2, `Stop` blocked with a generic `NOT_VERIFIED` status without running the fast test suite in-hook or showing the current broken file contents on disk.
     - On Turn 3, `qwen2.5:7b` re-wrote `src/cache/lru.mjs` with the same `this.map.delete(key)` ordering mistake, ran `npm test` on Turn 4 (`exit=1`), and exhausted its turn budget (`7,307` input tokens vs `4,014` baseline).

### 1.5 Root-Cause Fixes Applied

1. **ES6 Class Method Symbol Indexing ([`src/context/index.ts`](../src/context/index.ts)):** Updated `extractSymbols` so JavaScript ES6 class methods (`get(key) {`, `set(key, value) {`) are indexed even without TypeScript visibility keywords.
2. **Distractor Pruning & Co-Target Filtering ([`src/context/index.ts`](../src/context/index.ts)):** `formatCompactRepoMap` now prunes low-relevance files (`score < topScore * 0.45` unless they are a direct 1-hop import/importer of the `#1` file) and only inlines a 2nd `[Complete Current File]` block when the 2nd file is a direct import/importer of the 1st file or a high-confidence symbol co-target (`score >= topScore * 0.65`).
3. **Variable & Recursion Verification Header ([`src/context/index.ts`](../src/context/index.ts)):** Replaced the hasty `[Complete Current File: ... — edit directly with write_file]` header with `[Complete Current File: ... — verify variable values and recursion before calling write_file]`.
4. **In-Hook Silent Verification Probe & Modified-File Recovery Context ([`src/core/optimizer.ts`](../src/core/optimizer.ts)):** In `BALANCED` mode, `handleStop` runs the fast test check in-hook and, if a test fails (`FAILED`), immediately injects both the failing test output AND `[Current Modified File on Disk: ...]` so the agent can see and fix broken lines in a single turn.

---

## Regression 2: `task_03_deep_freeze_array`

### 2.1 Task Specification & Initial Code

- **Discovery Prompt:**
  > Fix `deepCloneConfig(obj)` where arrays are turned into plain objects `{0: ...}` because `typeof val === "object"` does not check `Array.isArray(val)`.
- **Target File (`src/config/clone.mjs`):**
  ```js
  export function deepCloneConfig(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const copy = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = deepCloneConfig(v);
    }
    return copy;
  }
  ```

### 2.2 Pre-Fix Trajectory Comparison

| Condition | Turn-by-Turn Tool Trajectory | Workspace Tests (`ws`) | Held-Out Oracle (`ora`) | Input Tokens | Output Tokens |
|---|---|---|---|---:|---:|
| `baseline` | `read_file_err -> list_files(11) -> read_file(src/config/clone.mjs) -> write_file(src/config/clone.mjs) -> write_file(src/config/clone.mjs) -> finish_task` | `true` | `true` | `3,668` | `713` |
| `context-only` (pre-fix) | `write_file(src/config/clone.mjs) -> finish_task` | `true` | `false` | `1,483` | `162` |
| `full-agent-opt` (pre-fix) | `write_file(src/config/clone.mjs) -> finish_task` | `true` | `false` | `1,483` | `162` |

### 2.3 First Meaningful Divergence

- **What `context-only` and `full-agent-opt` wrote on Turn 1 (pre-fix):**
  ```js
  export function deepCloneConfig(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return value; // Shallow-returns array reference without cloning nested elements!
    }
    ...
  ```
  Because the workspace test (`test/workspace.test.mjs`) only checked `assert.ok(Array.isArray(cloned.ports))` and `assert.deepEqual(cloned, input)` without mutating a nested object inside the array, `npm test` **passed (`ws = true`)**, while the independent held-out oracle test (`clone.a[1].b.push(4); assert.equal(orig.a[1].b.length, 2)`) **failed (`ora = false`)**!

### 2.4 Root-Cause Determination

1. **Why did the Turn-1 injected context induce a shallow patch?**
   - In `formatCompactRepoMap`, the verbose preamble (`"Top-ranked files for this task (avoid broad directory scanning; if a file is shown in full below, edit it directly with write_file without calling read_file first):"`) combined with listing `2. test/workspace.test.mjs` and the rushed `[Complete Current File: ... — edit directly with write_file]` tag caused `qwen2.5:7b` to append `|| Array.isArray(value)` to the base-case `if` guard instead of recursively mapping array elements.
2. **Did verification cause harmful actions?**
   - Verification did not cause the shallow edit, nor could `npm test` catch it because the workspace test only asserted `Array.isArray(cloned.ports)`. The regression was 100% caused by the noisy, rush-inducing `compactRepoMap` header format.

### 2.5 Post-Fix Verification on Both Regressions (`qwen2.5:7b`, `temperature = 0`)

After applying the context pruning and header fixes in [`src/context/index.ts`](../src/context/index.ts) and modular mode gates in [`src/core/optimizer.ts`](../src/core/optimizer.ts):

| Task ID | Mode | Workspace Tests (`ws`) | Held-Out Oracle (`ora`) | Input Tokens | Output Tokens | Turns | Stop Blocks | Trajectory |
|---|---|---|---|---:|---:|---:|---:|---|
| `task_01_lru_eviction` | `baseline` | `true` | `true` | `4,014` | `417` | `5` | `0` | `list_files -> read_file -> write_file -> run_command -> finish_task` |
| `task_01_lru_eviction` | `FAST` | **`true`** | **`true`** | **`1,864`** (`-53.6%`) | `247` | `2` | `0` | `write_file(src/cache/lru.mjs) -> finish_task` |
| `task_01_lru_eviction` | `BALANCED` | **`true`** | **`true`** | **`1,864`** (`-53.6%`) | `247` | `2` | `0` | `write_file(src/cache/lru.mjs) -> finish_task` (in-hook `VERIFIED`) |
| `task_01_lru_eviction` | `STRICT` | **`true`** | **`true`** | `4,371` | `318` | `4` | `1` | `write_file -> StopBlocked(NOT_VERIFIED) -> run_command(npm test) -> finish_task` |
| `task_03_deep_freeze_array` | `baseline` | `true` | `true` | `3,668` | `713` | `5` | `0` | `read_file_err -> list_files -> read_file -> write_file -> write_file -> finish_task` |
| `task_03_deep_freeze_array` | `FAST` | **`true`** | **`true`** | **`1,399`** (`-61.9%`) | `181` | `2` | `0` | `write_file(src/config/clone.mjs) -> finish_task` |
| `task_03_deep_freeze_array` | `BALANCED` | **`true`** | **`true`** | **`1,399`** (`-61.9%`) | `181` | `2` | `0` | `write_file(src/config/clone.mjs) -> finish_task` (in-hook `VERIFIED`) |
| `task_03_deep_freeze_array` | `STRICT` | **`true`** | **`true`** | `3,365` | `250` | `4` | `1` | `write_file -> StopBlocked(NOT_VERIFIED) -> run_command(npm test) -> finish_task` |

### 2.6 Permanent Regression Tests Added

Permanent automated regression tests are enforced in [`src/tests/agent-opt.test.ts`](../src/tests/agent-opt.test.ts) (`Suite 9: Regression & Modular Modes Suite`):
- **`9.1` (`task_01` regression guard):** Verifies ES6 class methods `get(key)` and `set(key, value)` are indexed in `src/cache/lru.mjs` and that low-relevance distractor `src/core/env.mjs` is never injected into `compactRepoMap`.
- **`9.2` (`task_03` regression guard):** Verifies `compactRepoMap` for `deepCloneConfig` excludes test file noise and includes the variable/recursion verification guard.
- **`9.3–9.6` (`FAST`, `BALANCED`, `STRICT` mode guards):** Verifies `FAST` never blocks `Stop`, `BALANCED` allows `Stop` with 0 continuations when its silent test probe passes and blocks `Stop` with `[Current Modified File on Disk]` when tests fail, and `STRICT` enforces explicit agent test execution.
