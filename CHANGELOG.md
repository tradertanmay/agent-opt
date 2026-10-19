# Changelog

All notable changes to **AgentOpt (`agent-opt`)** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-10-18

### Added
- **Provider-Independent Core (`AgentOptimizerCore`):**
  - `ContextEngine`: AST symbol/import indexing, dependency-aware context ranking, compact repo map injection (`<= 650` tokens), and redundant full-file read & identical-write prevention.
  - `TaskVerificationEngine`: Requirement extraction, verification command classification, and silent `<2s` in-hook verification probes.
  - `FailureDetectionEngine`: Consecutive failing command loop interception and root-cause diagnostic context injection.
  - `CrossSessionMemoryStore`: Evidence-gated, file-anchored project memory with automatic SHA-256 invalidation.
- **Modular Optimization Modes (`FAST`, `BALANCED`, `STRICT`):**
  - `FAST` (Default): AST/dependency context optimization (`<= 650` tokens), redundant full-file read & identical-write prevention, and lightweight loop detection with **zero `Stop`-hook continuations**.
  - `BALANCED` (Optional): Everything in `FAST` plus a `<2s` silent in-hook verification probe on `Stop` when source files are modified, releasing immediately on passing tests (`0` extra LLM turns) and blocking only on real test/requirement failures.
  - `STRICT` (Optional): Procedural verification requiring explicit agent test execution before completion.
- **One-Command Installer & Platform Auto-Detection (`npx agent-opt init`):**
  - Automatically detects installed coding agents (`Google Antigravity 2.0`, `Claude Code`, `OpenAI Codex CLI`, `Cursor`) on the developer's machine and workspace.
  - Interactive platform selector (when run in a TTY) and non-interactive `--platform` / `--yes` flags for scripts and CI.
  - Non-destructive configuration merging that preserves existing user hooks, permissions, MCP servers, and TOML configuration across `init`, `mode`, and `uninstall`.
  - Post-install verification (`verifyPlatformInstallation`) that validates manifests and executes a live hook smoke test.
- **First-Class CLI Commands & On-Demand MCP Server:**
  - `aopt status`, `aopt mode [FAST|BALANCED|STRICT]`, `aopt doctor`, `aopt context`, `aopt verify`, `aopt memory`, `aopt enable`, `aopt disable`, `aopt reset`, and `aopt uninstall`.
  - On-demand stdio MCP server (`AgentOptMcpServer`) exposing `agent_opt_query_context`, `agent_opt_read_symbol_slice`, `agent_opt_verify_status`, and `agent_opt_memory_lookup`.
- **Complete Google Antigravity 2.0 Plugin Bundle (`.agents/plugins/agent-opt/`):**
  - Ships `plugin.json` (`displayName`, `description`, `version`, `logo`, `suggestedPrompts`), `hooks.json`, `mcp_config.json`, `rules/AGENTS.md`, `skills/agent-opt/SKILL.md`, `assets/logo.svg`, and `README.md`.
- **Reproducible Evaluation Suites:**
  - 30-task single-repository development benchmark ([`src/real-benchmark/tasks.ts`](src/real-benchmark/tasks.ts)) and 15-task frozen multi-repository held-out benchmark ([`src/real-benchmark/held-out-tasks.ts`](src/real-benchmark/held-out-tasks.ts)).

