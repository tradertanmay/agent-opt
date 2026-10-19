# AgentOpt — Benchmark & Empirical Validation Report

> **See also:** [`docs/VALIDATION_AND_RELEASE_GATE_REPORT.md`](./VALIDATION_AND_RELEASE_GATE_REPORT.md) for the complete Priority 1–5 audit, platform integration smoke tests, safety guard verification, and release-gate decision.

---

## 1. Evidence Classification & Provenance

To maintain strict scientific and engineering credibility, every benchmark result in this repository is explicitly classified into one of three categories:

1. **`REAL_AGENT` (`benchmarks/real-agent-30-results.json`):**
   - **30 diverse, previously unseen coding tasks** across 6 categories (`bugfix`, `feature`, `multi_file`, `refactoring`, `validation`, `algorithms`) evaluated across **4 ablation conditions** (`120` total runs) using live LLM inference (`qwen2.5:7b` via local Ollama `http://127.0.0.1:11434/api/chat` at `temperature: 0`), genuine model-generated tool calls (`list_files`, `read_file`, `write_file`, `run_command`, `finish_task`), actual tokenizer-reported `prompt_eval_count` and `eval_count`, and an independent held-out executable test oracle (`node --test`).
   - Also includes a **live Google Antigravity 2.0 subagent execution** (`invoke_subagent`) with `.agents/plugins/agent-opt` installed (`benchmarks/agy-live-workspace`).
   - *Provenance Note:* Because proprietary `claude` and `codex` CLI binaries are not installed on this evaluation host, the 120-run ablation benchmark executed through our local Ollama tool-calling agent runner ([`src/real-benchmark/runner.ts`](../src/real-benchmark/runner.ts)) rather than the vendor `claude` or `codex` binaries.
2. **`ESTIMATED`:**
   - Equivalent API dollar costs (`$3.00 / 1M` input tokens, `$15.00 / 1M` output tokens) calculated from actual `prompt_eval_count` and `eval_count` token counts, and lexical token estimates (`countCalibratedTokens`) used internally for repo-map budget capping.
3. **`SIMULATED` ([`src/benchmark/index.ts`](../src/benchmark/index.ts)):**
   - The internal 6-task deterministic PRNG (`Mulberry32`) stress test (`npm run benchmark`). This runner uses scripted trajectories and synthetic token constants to test hook state-machine invariants deterministically in `< 1s` for CI; **it is an internal engineering stress test and must never be cited as real coding-agent performance.**

---

## 2. Real LLM Coding-Agent Benchmark Results ($N = 120$ Runs, 30 Unseen Tasks $\times$ 4 Conditions)

All confidence intervals for proportions use the **Wilson score 95% interval** at the independent task level ($n = 30$). Token and latency deltas use paired $t$-distribution 95% confidence intervals ($df = 29$).

| Metric | 1. Baseline (Unmodified Agent) | 2. Context Optimization Only | 3. Verification & Loop Detection Only | 4. Full AgentOpt (Post-Fix) |
| :--- | :--- | :--- | :--- | :--- |
| **Evidence Classification** | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) | `REAL_AGENT` (`qwen2.5:7b`) |
| **Held-Out Oracle Pass Rate** | **`43.3%`** (`13/30`) | **`63.3%`** (`19/30`, **`+20.0pp`**) | **`43.3%`** (`13/30`, `+0.0pp`) | **`70.0%`** (`21/30`, **`+26.7pp`**) |
| **Oracle 95% Wilson CI** | `[27.4%, 60.8%]` ($\pm 16.7\%$) | `[45.5%, 78.1%]` ($\pm 16.3\%$) | `[27.4%, 60.8%]` ($\pm 16.7\%$) | `[52.1%, 83.3%]` ($\pm 15.6\%$) |
| **Workspace `npm test` Pass Rate** | **`50.0%`** (`15/30`) | **`73.3%`** (`22/30`, **`+23.3pp`**) | **`50.0%`** (`15/30`, `+0.0pp`) | **`80.0%`** (`24/30`, **`+30.0pp`**) |
| **Mean Input Tokens (`prompt_eval_count`)** | `3,088` | **`1,605`** (**`-48.0%`**, CI `[-59.0%, -37.1%]`) | `3,827` (`+23.9%`) | **`2,819`** (**`-8.7%`**, CI `[-36.8%, +19.4%]`) |
| **Median Input Tokens** | `3,464` | **`1,597`** (**`-53.9%`**) | `3,672` (`+6.0%`) | **`1,662`** (**`-52.0%`**) |
| **Mean Output Tokens (`eval_count`)** | `374` | **`188`** (**`-49.6%`**, CI `[-63.6%, -35.6%]`) | `502` (`+34.1%`) | **`300`** (**`-19.8%`**, CI `[-42.4%, +2.7%]`) |
| **Mean Total Tokens** | `3,462` | **`1,793`** (**`-48.2%`**, CI `[-58.8%, -37.6%]`) | `4,329` (`+25.0%`) | **`3,119`** (**`-9.9%`**, CI `[-37.0%, +17.1%]`) |
| **Mean Wall-Clock Latency** | `9,341 ms` | **`5,101 ms`** (**`-45.4%`**) | `12,806 ms` (`+37.1%`) | **`8,653 ms`** (**`-7.4%`**, Median `6,007 ms` / **`-31.9%`**) |
| **Mean Hook Latency (% Overhead)** | `0.00 ms` (`0.0%`) | **`8.58 ms`** (**`0.18%`**) | **`14.94 ms`** (**`0.13%`**) | **`9.33 ms`** (**`0.13%`**) |
| **Cost per Verified Success (`ESTIMATED`)** | `$0.03433` | **`$0.01206`** (**`-64.9%`**) | `$0.04386` (`+27.8%`) | **`$0.01851`** (**`-46.1%`**) |

---

## 3. Platform Integration Verification Matrix

| Platform | Host Binary Detected | Verification Status | Verified Capabilities & Limitations |
| :--- | :--- | :--- | :--- |
| **Google Antigravity** | `Antigravity 1.107.0` + Active AGY 2.0 Runtime | **`VERIFIED`** | `.agents/plugins/agent-opt` bundle installed, CLI subprocess hooks (`PreInvocation`, `PreToolUse`, `PostToolUse`, `Stop`) verified, and live subagent coding task (`task_11`) passed held-out oracle. |
| **Cursor** | `Cursor 3.18.9` (`arm64`) | **`EXPERIMENTAL`** | `.cursor/hooks.json` installs cleanly and passes subprocess `stdin`/`stdout`/exit-code (`0`/`2`) smoke tests; GUI composer loop requires interactive GUI session. |
| **Claude Code** | Not installed on host | **`EXPERIMENTAL`** | `.claude/settings.json` passes all 5 lifecycle subprocess JSON contract smoke tests; `claude` CLI binary not installed on evaluation host. |
| **OpenAI Codex** | Not installed on host | **`EXPERIMENTAL`** | `.codex/hooks.json` + `.codex/config.toml` (`codex_hooks = true`) pass subprocess contract smoke tests; `codex` CLI binary not installed on evaluation host. |

---

## 4. Internal Deterministic Hook Stress Test (`SIMULATED`)

The internal 6-task stress test in [`src/benchmark/index.ts`](../src/benchmark/index.ts) verifies deterministic state-machine transitions (`PreToolUse` deduplication, `PostToolUse` loop breaking, `Stop` gate verification) in `< 1s` without an LLM. At $n = 6$ independent task templates, `6/6` simulated successes corresponds to a **Wilson 95% CI of `[61.0%, 100.0%]` ($\pm 19.5\%$)**.
