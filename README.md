# AgentOpt (`aopt`)

**AgentOpt — Make your AI coding agent smarter, faster, and more token-efficient.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node.js: >=20.0.0](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg)](./package.json)
[![Local-First: Zero Cloud Telemetry](https://img.shields.io/badge/Privacy-100%25_Local-success.svg)](./SECURITY.md)

**AgentOpt** is an open-source, local-first optimization plugin for **Google Antigravity**, **Claude Code**, **OpenAI Codex**, and **Cursor**. It wraps your coding agent's existing lifecycle hooks (`PreInvocation` / `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) to inject targeted AST symbol/dependency context, eliminate redundant file reads and duplicate writes, catch unproductive command loops, and optionally verify task completion before the agent stops.

**No new agent to learn. No API keys or accounts required. 100% local execution.**

---

## 1. Quickstart (Under 60 Seconds)

### One-Command Installation
Once published to npm, initialize AgentOpt in any repository with a single command:
```bash
npx agent-opt init
```

Or install directly from a local clone today:
```bash
git clone https://github.com/<org>/agent-opt.git
cd agent-opt && npm install && npm run build

# Run the installer in any target repository:
node /path/to/agent-opt/dist/cli/index.js init --cwd /path/to/your-project
# Or link `aopt` globally on your machine (`npm link`) and run:
aopt init
```

The installer automatically:
1. **Detects installed coding agents** on your machine and in your workspace (`Google Antigravity`, `Claude Code`, `OpenAI Codex`, `Cursor`).
2. **Lets you choose which platforms to wire** (interactive prompt in terminal, or `--platform all --yes` for non-interactive setup).
3. **Preserves all existing configuration** in `.claude/settings.json`, `.mcp.json`, `.cursor/hooks.json`, `.codex/config.toml`, and `.agent-opt/config.json`.
4. **Indexes workspace symbols & imports** and runs a post-install hook smoke test.

### Essential CLI Commands
```bash
aopt status                # View active mode, indexed symbols, installed platforms & token savings
aopt mode FAST             # Default: Context ranking + read/write dedup + loop guard (0 Stop blocks)
aopt mode BALANCED         # FAST + silent <2s test probe on Stop when source files change
aopt mode STRICT           # Requires explicit agent test execution before stopping
aopt doctor                # Validate manifests, AST index, memory anchors & hook execution
aopt context "<prompt>"    # Preview the ranked AST symbol & dependency map for any task
aopt disable | aopt enable # Pause or resume optimization without removing files
aopt uninstall             # Cleanly remove AgentOpt hooks while preserving your custom config
```

---

## 2. Selectable Optimization Modes (`FAST` | `BALANCED` | `STRICT`)

| Mode | Default? | Context & AST Slice Injection | Redundant Read/Write & Loop Guard | `Stop` Verification Gate | When to Use |
|---|---|---|---|---|---|
| **`FAST`** | **Yes (Default)** | Enabled (`<= 650` tokens) | Enabled (`PreToolUse` / `PostToolUse`) | Disabled (`0` Stop continuations) | Everyday interactive coding with minimum latency and maximum token efficiency |
| **`BALANCED`** | Optional (`aopt mode BALANCED`) | Enabled (`<= 650` tokens) | Enabled (`PreToolUse` / `PostToolUse`) | Runs a silent `<2s` test probe when source files change; releases immediately on pass (`0` extra LLM turns) and blocks only on real test/requirement failures | Bug fixes and multi-file refactors where you want automatic test verification without wasted LLM turns |
| **`STRICT`** | Optional (`aopt mode STRICT`) | Enabled (`<= 650` tokens) | Enabled (`PreToolUse` / `PostToolUse`) | Requires the agent to explicitly execute verification commands before `Stop` (up to `2` blocks/session) | Strict compliance workflows where test output must appear in the agent transcript |

---

## 3. Supported Platforms & Compatibility Matrix

AgentOpt uses a **provider-independent core** ([`src/core/optimizer.ts`](./src/core/optimizer.ts)) with thin platform adapters ([`src/adapters/index.ts`](./src/adapters/index.ts)). We strictly distinguish live vendor coding-agent validation from schema and subprocess contract testing:

| Platform | Installed Manifests & Hooks | Validation Status & Live Behavioral Interception |
|---|---|---|
| **Google Antigravity 2.0** | `.agents/plugins/agent-opt/{plugin.json,hooks.json,mcp_config.json,rules/AGENTS.md,skills/agent-opt/SKILL.md,assets/logo.svg}` | **Primary Verified (Live Agent + Interception)** — Live AGY 2.0 coding sessions (`dc463b89` vs `f940631b`): `PreInvocation` context map injection cut tool calls from **`5 → 2` (`-60.0%`)** (`0` exploratory reads); `PreToolUse` (`decision: "deny"`) and `Stop` (`decision: "continue"`) verified |
| **Claude Code (`v2.1.303`)** | `.claude/settings.json` + `.mcp.json` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) | **Live CLI & Interception Verified** — Validated with real `claude` CLI (`2.1.303`, `claude -p`, `claude doctor`, `claude mcp list`): `UserPromptSubmit` injected `428` context tokens; `PreToolUse` (`permissionDecision: "deny"`) blocked redundant file reads (`deduplicatedReads: 1`, `88` tokens saved); `BALANCED` mode `Stop` hook caught failing `CAD: 1.36` test (`verificationBlocks: 1`) |
| **OpenAI Codex CLI (`v0.163.0`)** | `.codex/hooks.json` (`{"hooks": {...}}`) + `.codex/config.toml` (`[features] hooks = true`) | **Live CLI & Interception Verified** — Validated with real `codex` CLI (`0.163.0`, `codex exec`, `codex features list`): in `BALANCED` mode (`session 01a151d6`), when Codex edited `rates.mjs` (`CHF: 0.9`) and tried to stop while `CAD: 1.36` failed, `Stop` hook returned exit code `2` (`hook: Stop Blocked`), causing Codex to add `CAD: 1.36`, pass `npm test`, and finish `VERIFIED` |
| **Cursor (`v3.18.9` / `cursor-agent 2026.10.16`)** | `.cursor/hooks.json` + `.cursor/mcp.json` (`sessionStart`, `beforeSubmitPrompt`, `beforeReadFile`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `stop`) | **Live CLI & Interception Verified** — Validated with real `cursor-agent` (`2026.10.16-e3cb207`, `cursor-agent -p` & `cursor-agent mcp list-tools agent-opt`): `sessionStart` symbol map injection reduced tool calls from **`6 → 4` (`-33.3%`)** and latency from **`10,375ms → 4,844ms` (`-53.3%`)**; `beforeReadFile` blocked duplicate reads (`deduplicatedReads: 1`, `102` tokens saved) |

---

## 4. Real Side-by-Side Demonstrations (`npm run demo` & Live Multi-Platform Runs)

Run `npm run demo` ([`src/examples/demo-60s.ts`](./src/examples/demo-60s.ts)) to execute the same multi-file task (`ho_06_bearer_scope_check` in `repo-http-gateway`: *"Trim bearer token in `parseAuthHeader` and verify scope in `authorizeRequest`"*) **Without AgentOpt** vs. **With AgentOpt**:

| Metric (`ho_06_bearer_scope_check`) | Without AgentOpt (`baseline`) | With AgentOpt (`FAST`) | With AgentOpt (`BALANCED`) |
|---|---:|---:|---:|
| **Independent Oracle Test Passed** | `FAIL` (`false`) | **`PASS` (`true`)** | **`PASS` (`true`)** |
| **Agent Tool Trajectory** | `list_files(10) -> read_file(bearer.mjs) -> read_file(bearer.mjs) -> write_file(bearer.mjs)` (read same file twice, missed `guard.mjs`) | **`write_file(bearer.mjs) -> write_file(guard.mjs) -> finish_task`** | **`write_file(bearer.mjs) -> write_file(guard.mjs) -> finish_task`** |
| **LLM Turns / Tool Calls** | `4` turns / `4` tool calls | **`3` turns / `2` tool calls** | **`3` turns / `2` tool calls** |
| **Wall-Clock Latency** | `7,275ms` | **`6,196ms` (`-14.8%`)** | **`5,833ms` (`-19.8%`)** |
| **Final Verification Status** | `NOT_APPLICABLE` | `NOT_VERIFIED` | **`VERIFIED` (`0` Stop blocks)** |

### Live Vendor Coding-Agent Behavioral Interception Summary

| Vendor Runtime | Without AgentOpt | With AgentOpt (`v0.1.0`) | Behavioral Change Demonstrated |
|---|---|---|---|
| **Google Antigravity 2.0** | `5` tool calls (`view_file` × 2, `grep_search`, `replace_file_content` × 2), `~1,890` context tokens | **`2` tool calls (`replace_file_content` × 2)**, `685` context tokens (**`-63.8%`**) | `PreInvocation` AST slice injection eliminated all exploratory discovery tool calls |
| **Cursor (`cursor-agent 2026.10.16`)** | `6` tool calls (`glob` -> `grep` -> `read` × 2 -> `edit` × 2), `10,375ms` latency | **`4` tool calls (`read` × 2 -> `edit` × 2)**, **`4,844ms` latency (`-53.3%`)** | `sessionStart` symbol map eliminated `glob` + `grep`; `beforeReadFile` blocked duplicate reads (`deduplicatedReads: 1`) |
| **OpenAI Codex CLI (`v0.163.0`)** | Stopped after adding only `CHF: 0.9` while `test/fx.test.mjs` failed on missing `CAD: 1.36` | `BALANCED` `Stop` hook returned exit code `2` (`hook: Stop Blocked`) with test error output | Codex read the hook failure reason, added `CAD: 1.36`, ran `npm test` (pass), and completed `VERIFIED` |
| **Claude Code (`v2.1.303`)** | Re-read unchanged `src/fx/rates.mjs` (`88` wasted tokens) and stopped on failing `CAD: 1.36` test | `PreToolUse` returned `permissionDecision: "deny"` (`deduplicatedReads: 1`); `Stop` hook returned `decision: "block"` | Prevented redundant file read in-flight and blocked premature stop when `npm test` failed |

---

## 5. Held-Out Multi-Repository Benchmark Results & Limitations

We evaluated `baseline`, `FAST`, `BALANCED`, and `STRICT` on a **frozen 15-task held-out test set across 5 unseen repositories** (`repo-fintech-ledger`, `repo-http-gateway`, `repo-workflow-dag`, `repo-schema-sanitizer`, `repo-search-analytics`, `60` real tool-calling trajectories using local `qwen2.5:7b` via Ollama at `temperature: 0`). Full methodology, per-task tables, and preserved failure logs are in [`docs/HELD_OUT_BENCHMARK_REPORT.md`](./docs/HELD_OUT_BENCHMARK_REPORT.md) and [`benchmarks/held-out-modes-results.json`](./benchmarks/held-out-modes-results.json).

| Metric (`N = 15` Held-Out Tasks across `5` Repos) | `baseline` (No Plugin) | `FAST` (Default Mode) | `BALANCED` (Silent Probe) | `STRICT` (Procedural Gate) |
|---|---:|---:|---:|---:|
| **Independent Oracle Completion Rate** | `46.7%` (`7/15`) | **`80.0%`** (`12/15`, **`+33.3%`**) | **`80.0%`** (`12/15`, **`+33.3%`**) | **`80.0%`** (`12/15`, **`+33.3%`**) |
| **95% Wilson Confidence Interval** | `[24.8%, 69.9%]` | `[54.8%, 93.0%]` | `[54.8%, 93.0%]` | `[54.8%, 93.0%]` |
| **Paired Task Outcomes vs. Baseline** | — | **`5W / 0L / 10T`** | **`5W / 0L / 10T`** | **`5W / 0L / 10T`** |
| **Mean Input Tokens (`prompt_eval_count`)** | `2,994` | **`1,734`** (**`-42.1%`**) | `2,402` (`-19.8%`) | `4,024` (`+34.4%`) |
| **Median Input Tokens** | `3,508` | **`1,478`** (**`-57.9%`**) | `1,524` (`-56.6%`) | `3,666` (`+4.5%`) |
| **95% Paired CI on Input Token Delta** | — | **`[-64.2%, -20.0%]`** | `[-57.5%, +17.9%]` | `[+3.9%, +64.8%]` |
| **Mean Output Tokens (`eval_count`)** | `355` | **`200`** (**`-43.7%`**) | `267` (`-25.0%`) | `331` (`-6.8%`) |
| **Mean Total Inference Tokens (`in + out`)** | `3,349` | **`1,934`** (**`-42.3%`**) | `2,669` (`-20.3%`) | `4,355` (`+30.0%`) |
| **Mean Wall-Clock Latency (`ms`)** | `8,259ms` | **`4,867ms`** (**`-41.1%`**) | `6,342ms` (`-23.2%`) | `8,161ms` (`-1.2%`) |
| **Total `Stop` Continuations (`15` tasks)** | `0` | **`0`** | `3` (only on failing tasks) | `15` (`1.0 / task`) |
| **Est. API Cost / Verified Success** | `$0.03067` | **`$0.01025`** (**`-66.6%`**) | `$0.01401` (`-54.3%`) | `$0.02130` (`-30.6%`) |

### Clear Limitations & Scope of Evidence
1. **Local Model Benchmark vs. Live Vendor Runtimes:** The 60-run multi-repository benchmark uses a real local tool-calling model (`qwen2.5:7b` via Ollama) to evaluate AgentOpt's core modes (`FAST`, `BALANCED`, `STRICT`) reproducibly at `$0.00` API cost. Live vendor runtime sessions (Google Antigravity 2.0, Claude Code `v2.1.303`, OpenAI Codex CLI `v0.163.0`, Cursor `cursor-agent 2026.10.16`) are evaluated separately in Section 4 above.
2. **Preserved Failures (`3/15` Tasks):** All 3 held-out tasks where `qwen2.5:7b` failed (`ho_03_fx_cross_conversion`, `ho_05_route_param_matcher`, `ho_11_mask_credit_card`) are preserved in [`benchmarks/held-out-modes-results.json`](./benchmarks/held-out-modes-results.json) and analyzed in [`docs/HELD_OUT_BENCHMARK_REPORT.md`](./docs/HELD_OUT_BENCHMARK_REPORT.md).
3. **Why `FAST` is Default:** Under our prespecified decision rule, `BALANCED` achieved the same `80.0%` (`12/15`) held-out completion rate as `FAST` while using more tokens (`2,402` vs. `1,734`) due to bounded verification retries on the 3 tasks where `qwen2.5:7b` could not solve the domain formula. Thus `FAST` is the default mode.

---

## 6. Configuration Example (`.agent-opt/config.json`)

AgentOpt stores all per-repository settings in `.agent-opt/config.json` (see [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) for all options):

```json
{
  "enabled": true,
  "mode": "FAST",
  "context": {
    "enabled": true,
    "maxInjectedTokens": 650,
    "topKFiles": 6,
    "topKSymbols": 12,
    "preventRedundantReads": true,
    "preventDuplicateWrites": true
  },
  "loopDetection": {
    "enabled": true,
    "maxIdenticalCommands": 2,
    "maxConsecutiveCommandFailures": 2,
    "maxRepeatedFileEditsWithoutTest": 3
  },
  "verification": {
    "enabled": false,
    "requireTestsOnCodeEdit": false,
    "runSilentProbeInHook": false,
    "silentProbeTimeoutMs": 2000,
    "maxStopBlocks": 0
  }
}
```

---

## 7. Roadmap

- **`v0.1.0` (Current Release):** Provider-independent core (`FAST`, `BALANCED`, `STRICT`), AST/dependency context slicer, SHA-256 read/write deduplication, loop guard, silent `<2s` verification probe, MCP server (`4` tools), and verified adapters for Google Antigravity 2.0, Claude Code (`v2.1.303`), OpenAI Codex CLI (`v0.163.0`), and Cursor (`v3.18.9` / `cursor-agent`).
- **`v0.2.0`:** Tree-sitter WASM optional grammar backend for C++, Java, Ruby, and PHP monorepos; incremental file-watcher cache invalidation.
- **`v0.3.0`:** Cross-session failure-pattern distillation and workspace-level token savings dashboard (`aopt dashboard`).

---

## 8. Documentation & Repository Guide

- **Installation & Uninstallation Guide:** [`docs/INSTALLATION.md`](./docs/INSTALLATION.md)
- **Configuration Reference (`.agent-opt/config.json`):** [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)
- **System Architecture:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Held-Out Multi-Repository Benchmark Report:** [`docs/HELD_OUT_BENCHMARK_REPORT.md`](./docs/HELD_OUT_BENCHMARK_REPORT.md)
- **Regression Root-Cause Analysis (`task_01` & `task_03`):** [`docs/REGRESSION_ROOT_CAUSE_ANALYSIS.md`](./docs/REGRESSION_ROOT_CAUSE_ANALYSIS.md)
- **Public Release Checklist & Known Limitations:** [`docs/RELEASE_CHECKLIST.md`](./docs/RELEASE_CHECKLIST.md)
- **Contributing Guide:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Security & Privacy Policy:** [`SECURITY.md`](./SECURITY.md)
- **Changelog:** [`CHANGELOG.md`](./CHANGELOG.md)
- **License:** [Apache-2.0](./LICENSE)
