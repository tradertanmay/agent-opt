# AgentOpt — Real-World Validation and Release Gate Report

**Date:** 2026-10-18  
**Host Environment:** macOS (`Darwin 25.6.0 arm64`), Node.js `v25.2.1`, TypeScript `5.9.3`  
**Evaluation Artifacts:**
- [`benchmarks/real-agent-30-results.json`](../benchmarks/real-agent-30-results.json) (Post-fix 30-task $\times$ 4-condition real LLM coding-agent dataset, $N = 120$ runs)
- [`benchmarks/real-agent-30-results-prefix.json`](../benchmarks/real-agent-30-results-prefix.json) (Pre-fix 30-task $\times$ 4-condition dataset that exposed the `[H1, H2, H2]` false edit-oscillation bug)
- [`benchmarks/platform-smoke-and-overhead.json`](../benchmarks/platform-smoke-and-overhead.json) (Priority 3 platform smoke tests & Priority 1 `tsserver` vs. `agent-opt` RSS/latency measurements)
- [`src/real-benchmark/tasks-30.ts`](../src/real-benchmark/tasks-30.ts) & [`src/real-benchmark/runner.ts`](../src/real-benchmark/runner.ts)
- [`src/tests/agent-opt.test.ts`](../src/tests/agent-opt.test.ts) (8 test suites covering all Priority 4 safety guards)

---

## Executive Summary & Release Gate Decision

**Release Gate Recommendation:** **`NO-GO` for Universal 4-Platform GA Launch; `CONDITIONAL GO` for `v0.1.0` (Scoped to Google Antigravity & Local Tool-Calling Agents).**

### Why we do NOT recommend a blanket Universal GA release today:
1. **Vendor CLI Availability on Evaluation Host:** While **Google Antigravity** (`v1.107.0` + active AGY 2.0 subagent runtime) and **Cursor** (`v3.18.9`) are installed on this machine, the proprietary **`claude` CLI** and **`codex` CLI** binaries are **not installed** in `PATH`. Consequently, our 120-run LLM coding-agent benchmark executed against a **local Ollama (`qwen2.5:7b`) tool-calling coding-agent harness** ([`src/real-benchmark/runner.ts`](../src/real-benchmark/runner.ts)) plus a **live Google Antigravity subagent run** (`invoke_subagent`), rather than inside the proprietary `claude` or `codex` CLI binaries.
2. **Token Savings vs. Verification Retry Trade-off:**
   - In **`context-only` mode**, AgentOpt reduced mean total tokens by **`-48.2%`** (`3,462 → 1,793`, 95% paired CI: `[-58.8%, -37.6%]`), reduced wall-clock latency by **`-45.4%`**, reduced cost per verified success by **`-64.9%`** (`$0.0343 → $0.0121`), and increased held-out oracle pass rate by **`+20.0` percentage points** (`43.3% → 63.3%`).
   - In **`full-agent-opt` mode** (post-fix), AgentOpt increased held-out oracle pass rate by **`+26.7` percentage points** (`43.3% → 70.0%`, `13/30 → 21/30`), increased workspace test pass rate by **`+30.0` percentage points** (`50.0% → 80.0%`), reduced **median** input tokens by **`-52.0%`** (`3,464 → 1,662`), and reduced cost per verified success by **`-46.1%`** (`$0.0343 → $0.0185`). However, **mean** total tokens across all 30 tasks decreased by **`-9.9%`** (`3,462 → 3,119`, 95% paired CI: `[-37.0%, +17.1%]`)—short of the `-15%` mean token reduction gate—because `Stop` hook verification intentionally forces 1–2 extra LLM repair turns when the model writes broken code on its first attempt (`35` total `Stop` interceptions across the 30 tasks).
3. **Two Edge-Case Regressions on `qwen2.5:7b`:** While `full-agent-opt` rescued **10 tasks** that `baseline` failed (`+26.7pp` net gain), there were **2 tasks** (`task_01_lru_eviction` and `task_03_deep_freeze_array`) where `baseline` passed the held-out oracle after reading `test/workspace.test.mjs`, whereas in `context-only` / `full-agent-opt` the 7B model edited the target file directly from the inline preview without reading the test file and missed a secondary edge case.

---

## Priority 1 — Audit of the Existing Benchmark (`src/benchmark/index.ts`)

We inspected [`BenchmarkRunner`](../src/benchmark/index.ts) line-by-line and audited every previously reported claim.

### 1.1 Answers to the 6 Audit Questions

| Audit Question | Finding in [`src/benchmark/index.ts`](../src/benchmark/index.ts) | Evidence Classification |
| :--- | :--- | :--- |
| **1. Were actual Claude Code, Codex, Cursor, or Antigravity model calls executed?** | **No.** `BenchmarkRunner.runSingleTrial()` did not invoke any LLM API or external agent CLI. | **`SIMULATED`** |
| **2. Did trials involve genuine model-generated tool calls, or predefined simulated trajectories?** | **Predefined simulated trajectories.** A deterministic PRNG (`Mulberry32`) branched over scripted `Read`, `Edit`, `Bash`, and `Stop` events. | **`SIMULATED`** |
| **3. Were input tokens obtained from provider usage accounting or calculated using an approximation?** | **Approximation + synthetic constants.** Repo map tokens used `countCalibratedTokens()` (lexical regex/byte estimator), and trial totals added hardcoded constants (`210`, `520`, `115`, `85`, etc.). | **`ESTIMATED`** / **`SIMULATED`** |
| **4. Was correctness measured through independent executable tests?** | **No.** The runner passed synthetic strings (`'PASS src/discount.test.ts'`) to `PostToolUse` rather than executing `node --test` on model-written code. | **`SIMULATED`** |
| **5. Were the 15 seeds independent model runs or deterministic variations of the same scripted behavior?** | **Deterministic PRNG variations** (`seed = 1001..1015`) over the same 6 task templates (`90` clustered trials per condition, not 90 independent tasks). | **`SIMULATED`** |
| **6. Were benchmark tasks or expected answers used while designing the optimizer?** | **Yes (in `v2`).** The `v2` iteration in `src/core/optimizer.ts` added `detectShellModifiedFiles()` specifically to satisfy `task_06`'s simulated `sed -i` failure mode. | **Contaminated (`v2` on `task_06`)** |

### 1.2 Correction of Confidence Intervals on the 6-Task Internal Stress Test

Reporting `90/90 = 100.0% (±0.0%)` treated 15 deterministic PRNG seeds across 6 tasks as $N = 90$ independent Bernoulli trials and applied the degenerate Wald formula $p \pm z\sqrt{p(1-p)/n}$, which collapses to $\pm 0.0\%$ at $p = 1.0$.

Computed properly at the **independent task level ($n = 6$)** using the **Wilson score 95% confidence interval** ([`computeWilson95CI`](../src/real-benchmark/runner.ts#L95-L115)):
- **6 / 6 tasks (`100.0%`)** has a 95% Wilson confidence interval of **`[61.0%, 100.0%]` ($\pm 19.5\%$)**—not `±0.0%`.
- **4 / 6 tasks (`66.7%`)** has a 95% Wilson confidence interval of **`[30.0%, 90.3%]` ($\pm 30.2\%$)**.

The old runner in [`src/benchmark/index.ts`](../src/benchmark/index.ts) is now explicitly labeled **`SIMULATED (Internal Deterministic Hook Stress Test)`** and is never represented as real coding-agent performance.

### 1.3 Replacing Broad Competitive Generalizations with Reproducible Local Measurements

We removed unverified generalizations ("MCP tools are ignored ~80% of the time", "LSP servers consume 1–4 GB of RAM") and executed [`measureLspVsAgentOptOverhead()`](../src/real-benchmark/platform-smoke-tests.ts#L304-L410) on this exact host (`Darwin 25.6.0 arm64`, Node `v25.2.1`, TypeScript `5.9.3`):

| Metric (Measured on Evaluation Host) | AgentOpt CLI / Engine | TypeScript `tsserver` LSP Daemon | Ratio / Comparison |
| :--- | :--- | :--- | :--- |
| **Cold Startup + Repo Index / Project Load Latency** | **`38.2 ms`** (subprocess `stdin`/`stdout`) | **`291.2 ms`** (`open` + `navbar` request) | **`7.6x` faster cold start** |
| **Warm In-Process Hook Latency** | **`2.1 ms`** (`8.6–9.3 ms` per full session) | N/A (persistent background daemon) | Sub-10ms per session |
| **Peak Resident Set Size (RSS Memory)** | **`52.4 MB`** (ephemeral Node CLI process) | **`268.7 MB`** (persistent daemon on 15-file repo) | **`5.1x` lower memory footprint** |

---

## Priority 2 — Real LLM Coding-Agent Experiments ($N = 120$ Runs across 30 Unseen Tasks)

### 2.1 Experimental Methodology & Provenance (`REAL_AGENT`)

Because `claude` and `codex` CLI binaries are not installed on this host, we evaluated **30 diverse, previously unseen coding tasks** ([`src/real-benchmark/tasks-30.ts`](../src/real-benchmark/tasks-30.ts)) across **4 ablation conditions (`120` total real LLM coding-agent runs)** using:
1. **Live Local LLM Inference:** `qwen2.5:7b` (`7.6B` parameters, `Q4_K_M`, `temperature: 0`, `num_ctx: 4096`) served by local **Ollama (`v0.40.4`)** at `http://127.0.0.1:11434/api/chat`.
2. **Genuine Model-Generated Tool Calls:** The model autonomously invoked `list_files`, `read_file`, `write_file`, `run_command`, and `finish_task` against real temporary repositories on disk containing 7 distractor modules across 6 subdirectories (`src/core/`, `src/utils/`, `src/metrics/`, `src/http/`, `src/storage/`, etc.). Explicit `src/...` file paths and `"Run tests to verify"` reminders were stripped from the user prompt ([`getDiscoveryPrompt`](../src/real-benchmark/runner.ts#L275-L284)) identically across all 4 conditions so file discovery and automatic verification were genuinely tested.
3. **Actual Model-Reported Token Accounting:** Input tokens (`prompt_eval_count`) and output tokens (`eval_count`) were recorded directly from Ollama's `llamacpp` response payload on every turn.
4. **Independent Executable Test Oracle:** After each agent run terminated, task correctness was evaluated by spawning a fresh `node --test` child process against a **held-out oracle test file (`heldOutOracleTestCode`)** that was never present in the workspace during the agent's execution.

### 2.2 Aggregate Results Across All 4 Conditions ($n = 30$ Unseen Tasks per Condition)

| Metric | 1. Baseline (Unmodified Agent) | 2. Context Optimization Only | 3. Verification & Loop Detection Only | 4. Full AgentOpt (Pre-Fix) | 5. Full AgentOpt (Post-Fix) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Evidence Classification** | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) |
| **Held-Out Oracle Pass Rate** | **`43.3%`** (`13/30`) | **`63.3%`** (`19/30`, **`+20.0pp`**) | **`43.3%`** (`13/30`, `+0.0pp`) | **`66.7%`** (`20/30`, **`+23.4pp`**) | **`70.0%`** (`21/30`, **`+26.7pp`**) |
| **Oracle 95% Wilson CI** | `[27.4%, 60.8%]` ($\pm 16.7\%$) | `[45.5%, 78.1%]` ($\pm 16.3\%$) | `[27.4%, 60.8%]` ($\pm 16.7\%$) | `[48.8%, 80.8%]` ($\pm 16.0\%$) | `[52.1%, 83.3%]` ($\pm 15.6\%$) |
| **Workspace `npm test` Pass Rate** | **`50.0%`** (`15/30`) | **`73.3%`** (`22/30`, **`+23.3pp`**) | **`50.0%`** (`15/30`, `+0.0pp`) | **`83.3%`** (`25/30`, **`+33.3pp`**) | **`80.0%`** (`24/30`, **`+30.0pp`**) |
| **Mean Input Tokens (`prompt_eval_count`)** | `3,088` | **`1,605`** (**`-48.0%`**) | `3,827` (`+23.9%`) | `4,321` (`+39.9%`) | **`2,819`** (**`-8.7%`**) |
| **Median Input Tokens** | `3,464` | **`1,597`** (**`-53.9%`**) | `3,672` (`+6.0%`) | `4,586` (`+32.4%`) | **`1,662`** (**`-52.0%`**) |
| **Mean Output Tokens (`eval_count`)** | `374` | **`188`** (**`-49.6%`**) | `502` (`+34.1%`) | `550` (`+47.2%`) | **`300`** (**`-19.8%`**) |
| **Mean Total Tokens** | `3,462` | **`1,793`** (**`-48.2%`**) | `4,329` (`+25.0%`) | `4,871` (`+40.7%`) | **`3,119`** (**`-9.9%`**) |
| **Mean Wall-Clock Time** | `9,341 ms` | **`5,101 ms`** (**`-45.4%`**) | `12,806 ms` (`+37.1%`) | `14,825 ms` (`+58.7%`) | **`8,653 ms`** (**`-7.4%`**) |
| **Median Wall-Clock Time** | `8,815 ms` | **`4,829 ms`** (**`-45.2%`**) | `12,931 ms` (`+46.7%`) | `11,371 ms` (`+29.0%`) | **`6,007 ms`** (**`-31.9%`**) |
| **Mean Hook Latency (% Overhead)** | `0.00 ms` (`0.0%`) | **`8.58 ms`** (**`0.18%`**) | **`14.94 ms`** (**`0.13%`**) | `15.54 ms` (`0.14%`) | **`9.33 ms`** (**`0.13%`**) |
| **Mean Tool Calls per Task** | `3.97` | **`1.10`** | `4.33` | `2.87` | **`1.67`** |
| **Stop Hook Interceptions (Total)** | `0` | `0` | `12` | `25` | `35` |
| **PreToolUse Redundant Blocks (Total)** | `0` | `0` | `0` | `0` | `10` |
| **Equivalent Cost per Trial (`ESTIMATED` at $3/$15 per 1M)** | `$0.01487` | **`$0.00764`** (**`-48.6%`**) | `$0.01901` (`+27.8%`) | `$0.02122` (`+42.7%`) | **`$0.01295`** (**`-12.9%`**) |
| **Cost per Verified Oracle Success (`ESTIMATED`)** | `$0.03433` | **`$0.01206`** (**`-64.9%`**) | `$0.04386` (`+27.8%`) | `$0.03183` (`-7.3%`) | **`$0.01851`** (**`-46.1%`**) |

### 2.3 Paired Task-Level Differences vs. Baseline ($n = 30$ Paired Tasks, 95% $t$-Intervals)

| Comparison vs. Baseline | Metric | Mean Baseline | Mean Treatment | Paired Mean $\Delta$ | % Change | 95% Confidence Interval (% Change) | Statistically Significant? |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`context-only` vs. `baseline`** | Input Tokens | `3,088.3` | `1,604.7` | `-1,483.6` | **`-48.0%`** | **`[-59.0%, -37.1%]`** | **Yes ($p < 0.0001$)** |
| **`context-only` vs. `baseline`** | Output Tokens | `374.0` | `188.4` | `-185.6` | **`-49.6%`** | **`[-63.6%, -35.6%]`** | **Yes ($p < 0.0001$)** |
| **`context-only` vs. `baseline`** | Total Tokens | `3,462.2` | `1,793.1` | `-1,669.1` | **`-48.2%`** | **`[-58.8%, -37.6%]`** | **Yes ($p < 0.0001$)** |
| **`context-only` vs. `baseline`** | Wall-Clock (ms) | `9,340.7` | `5,100.9` | `-4,239.8` | **`-45.4%`** | **`[-58.0%, -32.8%]`** | **Yes ($p < 0.0001$)** |
| **`verification-only` vs. `baseline`** | Input Tokens | `3,088.3` | `3,827.4` | `+739.1` | **`+23.9%`** | **`[+6.9%, +41.0%]`** | **Yes (Tokens Increased)** |
| **`full-agent-opt` (post-fix) vs. `baseline`** | Input Tokens | `3,088.3` | `2,819.2` | `-269.1` | **`-8.7%`** | **`[-36.8%, +19.4%]`** | No (Wide variance due to repair turns) |
| **`full-agent-opt` (post-fix) vs. `baseline`** | Output Tokens | `374.0` | `299.8` | `-74.2` | **`-19.8%`** | **`[-42.4%, +2.7%]`** | Borderline |
| **`full-agent-opt` (post-fix) vs. `baseline`** | Total Tokens | `3,462.2` | `3,118.9` | `-343.3` | **`-9.9%`** | **`[-37.0%, +17.1%]`** | No (Median `-52.0%`, Mean `-9.9%`) |

### 2.4 Category-Level Breakdown Across the 6 Task Categories ($5$ Tasks per Category)

| Task Category | Tasks | `baseline` Oracle % | `context-only` Oracle % | `verification-only` Oracle % | `full-agent-opt` (Post-Fix) Oracle % | `baseline` Mean InTok | `full-agent-opt` Mean InTok |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. `bugfix`** (`task_01..05`) | 5 | `80.0%` (`4/5`) | `40.0%` (`2/5`) | `80.0%` (`4/5`) | `40.0%` (`2/5`) | `3,446` | `3,878` |
| **2. `feature`** (`task_06..10`) | 5 | `0.0%` (`0/5`) | **`80.0%`** (`4/5`) | `0.0%` (`0/5`) | **`80.0%`** (`4/5`) | `1,337` | `2,248` |
| **3. `multi_file`** (`task_11..15`) | 5 | `60.0%` (`3/5`) | **`80.0%`** (`4/5`) | `60.0%` (`3/5`) | **`80.0%`** (`4/5`) | `3,546` | **`2,226`** (`-37.2%`) |
| **4. `refactoring`** (`task_16..20`) | 5 | `40.0%` (`2/5`) | **`60.0%`** (`3/5`) | `40.0%` (`2/5`) | **`60.0%`** (`3/5`) | `3,392` | **`2,608`** (`-23.1%`) |
| **5. `validation`** (`task_21..25`) | 5 | `20.0%` (`1/5`) | **`60.0%`** (`3/5`) | `20.0%` (`1/5`) | **`80.0%`** (`4/5`) | `3,167` | `3,221` |
| **6. `algorithms`** (`task_26..30`) | 5 | `60.0%` (`3/5`) | `60.0%` (`3/5`) | `60.0%` (`3/5`) | **`80.0%`** (`4/5`) | `3,641` | **`2,734`** (`-24.9%`) |
| **Total / Overall ($N=30$)** | **30** | **`43.3%` (`13/30`)** | **`63.3%` (`19/30`)** | **`43.3%` (`13/30`)** | **`70.0%` (`21/30`)** | **`3,088`** | **`2,819` (Median `1,662`)** |

### 2.5 Deep-Dive Failure & Regression Analysis (Why Real Experiments Matter)

Running 120 real LLM trials uncovered three critical insights that simulated benchmarks completely missed:

1. **Why `baseline` and `verification-only` got `0%` on `feature` tasks (`task_06..10`):**
   - Without `AgentOpt`'s `UserPromptSubmit` repository symbol map, when asked to implement or update a function (`chunkArray`, `slugifyUrl`, `MovingAverage`, `parseQueryParams`, `symmetricDifference`), `qwen2.5:7b` frequently guessed a plausible-sounding path like `src/utils/array.js` instead of calling `list_files` to find `src/collection/chunk.mjs`.
   - With `context-only` or `full-agent-opt`, `AgentOpt` indexed the repo symbols and injected `1. src/collection/chunk.mjs` into the prompt on Turn 1, jumping completion on `feature` tasks from **`0%` to `80%` (`4/5`)**.
2. **Real Bug Discovered & Fixed in `FailureDetectionEngine` (`[H1, H2, H2]` False Edit Oscillation):**
   - In our first 120-run pass (`benchmarks/real-agent-30-results-prefix.json`), `full-agent-opt` averaged `4,321` input tokens (`+39.9%` over baseline) because on several tasks (`task_17`, `task_20`, `task_23`, `task_26`), `qwen2.5:7b` called `write_file` twice with the same fixed code (`H1 → H2 → H2`).
   - `recordFileModification` pushed the duplicate `H2` into `sha256History` (`[H1, H2, H2]`), and `detectEditOscillation` saw that `H2` existed earlier in `sha256History` and falsely fired `[AgentOpt Thrash Detector] You are oscillating edits... formulate a distinct fix`, causing the model to loop for 5 turns!
   - Fixing `detectEditOscillation` ([`src/failure/index.ts`](../src/failure/index.ts#L260-L284)) and adding `PreToolUse` duplicate-write blocking ([`src/core/optimizer.ts`](../src/core/optimizer.ts#L286-L316)) cut `full-agent-opt` mean input tokens from **`4,321` down to `2,819` (`-34.8%` reduction)** and improved held-out oracle pass rate from **`66.7%` (`20/30`) to `70.0%` (`21/30`)**.
3. **Why `bugfix` had 2 regressions (`task_01_lru_eviction` and `task_03_deep_freeze_array`) when inline file previews were injected:**
   - In `baseline`, `qwen2.5:7b` called `list_files` and read both the target file and `test/workspace.test.mjs`, seeing the test assertions before writing code.
   - In `context-only` and `full-agent-opt`, because `[Complete Current File: src/...]` was injected in `UserPromptSubmit`, `qwen2.5:7b` immediately called `write_file` on Turn 1 without reading `test/workspace.test.mjs`. On `task_03_deep_freeze_array`, its edit passed `test/workspace.test.mjs` (`ws=1`) so `Stop` verification allowed completion, but it missed nested array recursion inside objects tested by `heldOutOracleTestCode` (`ora=0`).

### 2.6 Live Google Antigravity 2.0 Subagent Trial (`invoke_subagent`)

In addition to the 120 local Ollama trials, we executed a live Google Antigravity 2.0 subagent trial (`conversationId: d9ab09d1-93d1-43e7-8d48-a691a3321a2a`) inside `benchmarks/agy-live-workspace` with `.agents/plugins/agent-opt` installed on multi-file `task_11_tax_jurisdiction`:
- `PreInvocation` CLI hook returned `exitCode: 0` and injected ranked files `src/tax/rates.mjs` and `src/tax/calculator.mjs`.
- Before running tests, the `Stop` CLI hook returned `{"decision":"continue","reason":"[AgentOpt Task Verification Gate — Status: NOT_VERIFIED] ..."}` (preventing premature stop).
- After running `npm test` (`37.95 ms`, `1/1` passing), the `Stop` CLI hook returned `{"decision":"allow"}` (`VERIFIED`), and the workspace passed the independent held-out oracle test (`Oracle: CA tax rate and existing NY/TX rates with 2-decimal rounding`).

---

## Priority 3 — Platform Integration Verification & Smoke Tests

We executed [`runAllPlatformSmokeTests()`](../src/real-benchmark/platform-smoke-tests.ts) testing installation, `stdin`/`stdout`/`exitCode` CLI subprocess hook execution, context injection, duplicate-read blocking, `Stop` gate blocking/allowing, and clean uninstallation across all 4 target platforms:

| Platform | Host Binary Detected | Status | Config Files Created & Verified | Subprocess Hook Latency | Exact Block Output / Exit Code Verified | Key Limitations Observed |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Google Antigravity** | **Yes** (`Antigravity 1.107.0` + Active AGY 2.0 Runtime) | **`VERIFIED`** | `.agents/plugins/agent-opt/plugin.json`, `hooks.json`, `mcp_config.json`, `rules/AGENTS.md` | `36.39 ms` | `exitCode: 0`, `{"decision":"continue","reason":"..."}` on `Stop`; `{"decision":"deny"}` on `PreToolUse` | Subagents share parent workspace unless `Workspace="branch"` is set. |
| **Cursor** | **Yes** (`Cursor 3.18.9`, commit `2ba48ff3f751`, `arm64`) | **`EXPERIMENTAL`** | `.cursor/hooks.json` | `34.53 ms` | `exitCode: 0` (`{"decision":"block"}` on `Stop`), `exitCode: 2` on `PreToolUse` block | Cursor GUI composer cannot be headlessly automated in CLI tests; `beforeSubmitPrompt` stdout is not injected into prompt without `.cursor/rules` or MCP. |
| **Claude Code** | **No** (`claude` CLI not in `PATH` on host) | **`EXPERIMENTAL`** | `.claude/settings.json` | `34.01 ms` | `exitCode: 0`, `{"decision":"block","reason":"..."}` | All 5 lifecycle hooks verified via CLI subprocess contract, but vendor `claude` binary was not executed on this machine. |
| **OpenAI Codex** | **No** (`codex` CLI not in `PATH` on host) | **`EXPERIMENTAL`** | `.codex/hooks.json`, `.codex/config.toml` (`codex_hooks = true`) | `34.51 ms` | `exitCode: 2`, `{"decision":"block","reason":"..."}` | Generates both `.codex/hooks.json` and `.codex/config.toml` (`codex_hooks = true`), but vendor `codex` binary was not executed on this machine. |

---

## Priority 4 — Dangerous Optimization Edge Cases Fixed & Verified

All 10 dangerous optimization failure modes are tested and passing in Test Suite #8 of [`src/tests/agent-opt.test.ts`](../src/tests/agent-opt.test.ts#L565-L890):

| # | Dangerous Failure Mode | Root Cause Found | Fix Implemented & Verified |
| :--- | :--- | :--- | :--- |
| **4.1** | Legitimate full-file reread blocked before editing | `evaluateFileRead()` blocked any 2nd full-file read even after the agent inspected other files in between. | [`src/context/index.ts`](../src/context/index.ts#L483-L494): Only blocks immediate consecutive back-to-back reads of the exact same unchanged file (`lastReadStep === session.stepCount`). |
| **4.2** | Same-`mtime` / same-byte-length file modification missed | `buildRepoGraph()` trusted cached `(mtimeMs, sizeBytes)` without hashing content. | [`src/context/index.ts`](../src/context/index.ts#L95-L108): Always computes `sha256String(content)` on disk read so same-size edits invalidate read caches immediately. |
| **4.3** | Documentation-only or read-only Q&A blocked by `Stop` | Assistant text mentioning `"tests pass"` triggered false-positive unverified completion blocks on Q&A turns. | [`src/verification/index.ts`](../src/verification/index.ts#L117-L129): `isQuestionOnlyPrompt()` and `modifiedSourceFiles.length === 0` never block `Stop`. |
| **4.4** | Existing tests pass while requested feature is a sham/comment edit | Comment-only edits (`// fixed`) satisfied `modifiedSourceFiles.length > 0` when pre-existing tests already passed. | [`src/core/optimizer.ts`](../src/core/optimizer.ts#L690-L711): Strips comments/whitespace to compute `hasSubstantiveCodeChange`; flags comment-only edits as `FAILED`. |
| **4.5** | Repository with no test runner blocked on `Stop` | `Stop` demanded `npm test` even when `package.json` had no test script. | [`src/verification/index.ts`](../src/verification/index.ts#L384-L403): `detectProjectVerificationCommands()` checks manifests; if `hasRunnableVerificationSuite === false`, `Stop` returns `allow` (`NOT_VERIFIED`). |
| **4.6** | Developer intentionally skips tests or cancels turn | User prompts saying `"skip tests"` or IDE `user_cancel` events were blocked by `Stop`. | [`src/verification/index.ts`](../src/verification/index.ts#L50-L65): `isUserVerificationOptOut()` and `userInitiatedStop` bypass `Stop` blocking. |
| **4.7** | Infinite `Stop` hook blocking loop | Repeated `Stop` blocks could trap an agent when `stop_hook_active: true`. | [`src/core/optimizer.ts`](../src/core/optimizer.ts#L598-L602): When `stop_hook_active: true`, caps blocking to a single turn (`session.stopBlockCount < 1`). |
| **4.8** | Secrets or prompt-injection in repository files leaked into context | Repo maps and failure snippets injected raw file text without secret/injection filtering. | [`src/security/index.ts`](../src/security/index.ts): `isSensitiveFilePath()` excludes `.env`/`*.pem`/`*.key`, and `sanitizeContextText()` redacts API keys and neutralizes prompt-injection directives. |
| **4.9** | Concurrent agent sessions corrupting state or cross-contaminating dirty files | Non-atomic `fs.writeFileSync` and shared repo graph hashes caused Session B's edits to block Session A. | [`src/security/index.ts`](../src/security/index.ts#L127-L137): Atomic PID+random temp-file rename (`writeJsonAtomic`) + session-scoped `workspaceBaselineHashes`. |
| **4.10** | Duplicate identical `Write` (`[H1, H2, H2]`) triggering false `A → B → A` oscillation | Discovered in Priority 2: writing identical content twice pushed `[H1, H2, H2]` and falsely triggered `EDIT_OSCILLATION_LOOP`. | [`src/failure/index.ts`](../src/failure/index.ts#L260-L284) & [`src/core/optimizer.ts`](../src/core/optimizer.ts#L286-L316): Requires `latestSha !== immediatelyPrecedingSha` for oscillation and blocks redundant identical writes in `PreToolUse`. |

---

## Priority 5 — Release Criteria Assessment

| Release Criterion | Target Threshold | Measured Real-World Result | Status |
| :--- | :--- | :--- | :--- |
| **1. Task Completion Rate** | `>= +10pp` improvement or non-degraded | **`+26.7pp`** (`43.3% → 70.0%` in `full-agent-opt`; **`+20.0pp`** `43.3% → 63.3%` in `context-only`) | **PASS** |
| **2. Cost per Verified Success** | `>= 20%` reduction | **`-46.1%`** (`$0.0343 → $0.0185` in `full-agent-opt`; **`-64.9%`** `$0.0343 → $0.0121` in `context-only`) | **PASS** |
| **3. Total Token Usage** | `>= 15%` reduction | **`-48.2%` mean** in `context-only` (**PASS**); **`-52.0%` median / `-9.9%` mean** in `full-agent-opt` (**PARTIAL** due to `Stop` repair turns) | **PARTIAL** |
| **4. Hook Latency Overhead** | `< 5%` of total runtime | **`0.13% – 0.18%`** (`8.58–9.33 ms` mean in-process; `34–38 ms` subprocess) | **PASS** |
| **5. Regressions on Baseline-Passing Tasks** | `0` serious regressions | `10` baseline failures rescued, but `2` baseline-passing tasks (`task_01`, `task_03`) missed an oracle edge case when `qwen2.5:7b` skipped reading tests | **NEEDS WORK** |
| **6. Installation Time** | `< 2 minutes` | **`< 1 second`** (`~45 ms` via `agent-opt install`) | **PASS** |
| **7. Verified Platform Integrations** | `>= 1` thoroughly `VERIFIED` | **Google Antigravity `VERIFIED`**; Claude Code, Cursor, and OpenAI Codex `EXPERIMENTAL` | **PASS (1 of 4)** |

### Concrete Requirements Before Universal GA Launch (`v1.0`)
1. **Include Target Test Assertions in `UserPromptSubmit` Preview:** When injecting `[Complete Current File]` previews for short source files, also include the top matching test assertion block (`10–15` lines from `test/*.test.*`) so smaller models do not skip reading edge-case assertions (addressing the 2 regressions on `task_01` and `task_03`).
2. **Execute End-to-End Vendor Binary Benchmarks on `claude` and `codex`:** Run the 30-task suite inside an environment with authenticated `claude` CLI and `codex` CLI binaries installed to promote their status from `EXPERIMENTAL` to `VERIFIED`.
