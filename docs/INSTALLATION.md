# AgentOpt — Installation & Uninstallation Guide

**AgentOpt — Make your AI coding agent smarter, faster, and more token-efficient.**

AgentOpt installs into your project in under two minutes with zero external services, zero API keys, and 100% local execution.

---

## 1. Prerequisites

- **Node.js:** `>= 20.0.0` (`node -v`)
- **Operating Systems:** macOS, Linux, or Windows (POSIX and Windows paths supported)

---

## 2. One-Command Installation

### Option A: Via `npx`
Run the interactive installer inside any repository:
```bash
npx agent-opt init
```

Or install non-interactively for all detected platforms in default `FAST` mode:
```bash
npx agent-opt init --yes
```

### Option B: From Source Clone
```bash
git clone https://github.com/tradertanmay/agent-opt.git
cd agent-opt
npm install
npm run build

# Link `aopt` / `agent-opt` globally on your machine (optional)
npm link

# Initialize inside any target project directory
node /path/to/agent-opt/dist/cli/index.js init --cwd /path/to/your-repo
# Or if linked via `npm link`:
aopt init
```

---

## 3. What `npx agent-opt init` Does

1. **Detects Installed Coding Agents:** Scans your environment and workspace for:
   - **Google Antigravity 2.0** (`~/.gemini/antigravity`, `.agents/`, `ANTIGRAVITY_LS_ADDRESS`, `agy`)
   - **Claude Code** (`~/.claude`, `.claude/`, `CLAUDE_CODE`, `claude`)
   - **OpenAI Codex CLI** (`~/.codex`, `.codex/`, `CODEX_HOME`, `codex`)
   - **Cursor** (`~/.cursor`, `.cursor/`, `CURSOR_TRACE_ID`, `cursor`)
2. **Lets You Select Target Platforms:**
   - Interactive prompt when run in a terminal (`1-4`, comma-separated, `all`, or `Enter` for detected agents).
   - Or explicit flag: `--platform google-antigravity`, `--platform claude-code,cursor`, or `--platform all`.
3. **Preserves Existing Configuration:**
   - Never overwrites your existing `.claude/settings.json` permissions or custom hooks, `.mcp.json` servers, `.cursor/hooks.json` hooks, `.codex/config.toml` model settings, or custom `.agent-opt/config.json` thresholds.
4. **Builds Local AST & Memory Index:**
   - Indexes workspace symbols and imports into `.agent-opt/cache/repo-graph.json` and bootstraps verified test/build commands into `.agent-opt/memory/project-memory.json`.
5. **Validates the Installation:**
   - Verifies every generated manifest and runs a live hook smoke test (`[PASS] <platform>: Manifests valid & hook smoke check passed`).

---

## 4. Platform-Specific Files & Validation Matrix

| Platform | Files Created / Merged in Workspace | Validation Status |
|---|---|---|
| **Google Antigravity 2.0** | `.agents/plugins/agent-opt/plugin.json`<br>`.agents/plugins/agent-opt/hooks.json`<br>`.agents/plugins/agent-opt/mcp_config.json`<br>`.agents/plugins/agent-opt/rules/AGENTS.md`<br>`.agents/plugins/agent-opt/skills/agent-opt/SKILL.md`<br>`.agents/plugins/agent-opt/assets/logo.svg`<br>`.agents/plugins/agent-opt/README.md` | **Primary Verified (Live Agent + Interception)** — End-to-end tested with live Google Antigravity 2.0 subagents (`PreInvocation` reduced tool calls `5 → 2`, `PreToolUse` `deny`, `Stop` `continue`) and subprocess hook execution |
| **Claude Code (`v2.1.303`)** | `.claude/settings.json` (merges `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` hooks)<br>`.mcp.json` (merges `mcpServers["agent-opt"]`) | **Live CLI & Interception Verified** — End-to-end tested with real `claude` CLI (`2.1.303`, `claude -p`, `claude doctor`, `claude mcp list`), confirming context map injection (`428` tokens), `PreToolUse` duplicate read blocking (`deduplicatedReads: 1`), and `BALANCED` mode `Stop` hook verification blocking (`verificationBlocks: 1`) |
| **OpenAI Codex CLI (`v0.163.0`)** | `.codex/hooks.json` (merges `{"hooks": {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"}}`)<br>`.codex/config.toml` (adds `# BEGIN AGENT-OPT` block with `[features] hooks = true`) | **Live CLI & Interception Verified** — End-to-end tested with real `codex` CLI (`0.163.0`, `codex exec`, `codex features list`), confirming `BALANCED` mode `Stop` hook blocks premature completion on failing tests (`exit code 2`, `hook: Stop Blocked`) and forces Codex to fix the missing `CAD: 1.36` rate before finishing `VERIFIED` |
| **Cursor (`v3.18.9` / `cursor-agent 2026.10.16`)** | `.cursor/hooks.json` (merges `sessionStart`, `beforeSubmitPrompt`, `beforeReadFile`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `stop`)<br>`.cursor/mcp.json` (merges `mcpServers["agent-opt"]`) | **Live CLI & Interception Verified** — End-to-end tested with real `cursor-agent` (`2026.10.16-e3cb207`, `cursor-agent -p` & `cursor-agent mcp list-tools agent-opt`), confirming `sessionStart` symbol map injection cuts tool calls (`6 → 4`) and latency (`-53.3%`), and `beforeReadFile` blocks redundant file reads (`deduplicatedReads: 1`) |

---

## 5. Essential CLI Commands

```bash
# Check installation status, active mode, indexed symbols, and telemetry
aopt status

# Switch optimization mode (FAST is default; BALANCED and STRICT are optional)
aopt mode FAST
aopt mode BALANCED
aopt mode STRICT

# Run full diagnostic & live hook smoke check
aopt doctor

# Preview the ranked AST context map for any prompt
aopt context "Fix daily compound interest rate division in computeDailyCompound"

# Temporarily disable or re-enable AgentOpt without removing files
aopt disable
aopt enable
```

---

## 6. Clean Uninstallation

Remove AgentOpt hooks from a single platform or all platforms while **preserving all pre-existing user hooks, permissions, MCP servers, and TOML settings**:

```bash
# Remove AgentOpt hooks from all platforms (keeps .agent-opt/ history)
aopt uninstall

# Remove AgentOpt hooks AND delete .agent-opt/ config, cache, and session logs
aopt uninstall --purge

# Remove only a specific platform adapter
aopt uninstall --platform cursor
```
