# AgentOpt (`v0.1.0`) — Public GitHub Release Checklist & Known Limitations

> **Release Readiness Status:** **READY FOR PUBLIC GITHUB RELEASE (`v0.1.0`)**  
> **Hard Constraint Observed:** Nothing has been pushed to GitHub or published externally. All release artifacts, git history, and verification suites are prepared locally in the repository root.

---

## 1. Final Release Checklist (10 / 10 Complete)

| # | Deliverable | Status | Verification Evidence |
|---|---|---|---|
| 1 | **Fully working source code (`FAST` default, `BALANCED`, `STRICT`)** | **COMPLETE** | `npm run build` & `npm run typecheck` exit `0` with zero errors ([`src/`](../src/)) |
| 2 | **Installable plugin package (`agent-opt@0.1.0`)** | **COMPLETE** | `npx agent-opt init` / `aopt init`, `aopt status`, `aopt mode`, `aopt doctor`, `aopt uninstall` verified; local `.tgz` package built via `npm pack` |
| 3 | **Validated platform integrations** | **COMPLETE** | Google Antigravity 2.0 (`Primary Verified` live + subprocess), Claude Code `v2.1.303` (`Live CLI & Interception Verified` via `claude -p`, `claude doctor`, `claude mcp list`), OpenAI Codex CLI `v0.163.0` (`Live CLI & Interception Verified` via `codex exec` & `codex features list`), Cursor `v3.18.9` / `cursor-agent 2026.10.16-e3cb207` (`Live CLI & Interception Verified` via `cursor-agent -p` & `cursor-agent mcp list-tools agent-opt`) |
| 4 | **Passing automated tests (all 10 engineering categories)** | **COMPLETE** | `npm test` passes `10/10` test suites (`0` failures) in [`src/tests/agent-opt.test.ts`](../src/tests/agent-opt.test.ts) |
| 5 | **GitHub-ready documentation & community files** | **COMPLETE** | [`README.md`](../README.md), [`LICENSE`](../LICENSE) (Apache-2.0), [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md), [`CHANGELOG.md`](../CHANGELOG.md), [`docs/INSTALLATION.md`](./INSTALLATION.md), [`docs/CONFIGURATION.md`](./CONFIGURATION.md), [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) |
| 6 | **Versioned release artifacts & CI workflows** | **COMPLETE** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/release.yml`](../.github/workflows/release.yml), issue/PR templates in [`.github/`](../.github/) |
| 7 | **Clear compatibility matrix** | **COMPLETE** | Documented in [`README.md`](../README.md) and [`docs/INSTALLATION.md`](./INSTALLATION.md) |
| 8 | **Reproducible side-by-side demonstration** | **COMPLETE** | `npm run demo` ([`src/examples/demo-60s.ts`](../src/examples/demo-60s.ts)) + [`benchmarks/launch-demo-recording.json`](../benchmarks/launch-demo-recording.json) |
| 9 | **Known limitations & honest benchmark boundaries** | **COMPLETE** | Documented in Section 2 below and [`docs/HELD_OUT_BENCHMARK_REPORT.md`](./HELD_OUT_BENCHMARK_REPORT.md) |
| 10 | **No recruitment, waitlist, or external campaign bloat** | **COMPLETE** | Prepared for direct open-source GitHub release |

---

## 2. Known Limitations & Epistemic Boundaries

1. **Vendor CLI Runtime Validation on Build Host (`darwin arm64`):**
   - **Google Antigravity 2.0:** Tested end-to-end using live Google Antigravity 2.0 subagents (`dc463b89` Without AgentOpt vs `f940631b` With AgentOpt, plus `d9ab09d1`), where `PreInvocation` context map injection cut tool calls from `5` to `2` (`-60.0%`), and subprocess hook execution verified `PreToolUse` (`deny`) and `Stop` (`continue`).
   - **Claude Code (`v2.1.303`, `@anthropic-ai/claude-code`):** Installed and tested end-to-end via `claude doctor`, `claude mcp list`, and live `claude -p` coding sessions (`bbe2ea33`, `f4a0c018`, `76bd7297`), demonstrating `UserPromptSubmit` context injection (`428` tokens), `PreToolUse` duplicate read blocking (`permissionDecision: "deny"`, `deduplicatedReads: 1`, `88` tokens saved), and `BALANCED` mode `Stop` hook verification blocking (`decision: "block"` on failing `CAD: 1.36` test).
   - **OpenAI Codex CLI (`v0.163.0`, `@openai/codex`):** Installed and tested end-to-end via `codex features list` and live `codex exec` coding sessions (`01a151af` in `FAST` mode; `01a151d6` in `BALANCED` mode). In `BALANCED` mode, when Codex added `CHF: 0.9` and attempted to stop while `CAD: 1.36` failed in `npm test`, the `Stop` hook returned exit code `2` (`hook: Stop Blocked`), causing Codex to add `CAD: 1.36`, run `npm test`, and finish `VERIFIED`. Note: non-interactive `codex exec` runs in a brand-new folder require either interactive TUI approval of `.codex/hooks.json` or `--dangerously-bypass-hook-trust`.
   - **Cursor (`v3.18.9` IDE + `cursor-agent 2026.10.16-e3cb207` CLI):** Installed and tested end-to-end via `cursor-agent -p` and `cursor-agent mcp list-tools agent-opt` (`agent-opt: ready`). In a paired live coding run (`/tmp/cursor-live-without` vs `/tmp/cursor-live-with`, session `a8793e83`), `sessionStart` symbol map injection eliminated `globToolCall` and `grepToolCall`, reducing tool calls from `6 → 4` (`-33.3%`) and latency from `10,375ms → 4,844ms` (`-53.3%`); `beforeReadFile` blocked duplicate consecutive file reads (`deduplicatedReads: 1`, `102` tokens saved).
2. **Held-Out Benchmark Sample Size & Model Scope:**
   - The frozen multi-repository held-out benchmark (`N = 15` unseen tasks across `5` repositories, `60` runs) and the preliminary development set (`N = 30` tasks, `60` runs) were executed using a real local tool-calling LLM (`qwen2.5:7b` via Ollama at `temperature: 0`).
   - While `FAST` mode improved held-out oracle completion from **`46.7%` (`7/15`) to `80.0%` (`12/15`, `+33.3%`, `5W / 0L / 10T`)** and reduced provider-reported input tokens by **`-42.1%`** (`2,994 → 1,734`), 3 held-out tasks (`ho_03_fx_cross_conversion`, `ho_05_route_param_matcher`, `ho_11_mask_credit_card`) failed across all modes on `qwen2.5:7b` due to 7B-parameter mathematical/regex reasoning limits.
3. **Regex/Lexical AST Indexing Scope:**
   - `ContextEngine` uses fast, zero-dependency lexical/AST regex parsers for TypeScript, JavaScript/ESM, Python, Go, and Rust (`<15ms` latency). Extremely dynamic metaprogramming or macro-generated symbols may not be statically indexed.

---

## 3. How to Publish When Approved

Nothing has been pushed externally. When you are ready to publish to GitHub and npm:

```bash
# 1. Verify tests and package contents locally
npm test
npm pack --dry-run

# 2. Add your GitHub remote and push main + v0.1.0 tag
git remote add origin https://github.com/tradertanmay/agent-opt.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0

# 3. (Optional) Publish to npm so `npx agent-opt init` works from the public registry
npm publish --access public
```
