# Security & Privacy Policy

## Local-First & Zero Telemetry Guarantee

- **No External Network Calls:** AgentOpt executes 100% locally on your machine. It never transmits source code, prompts, file paths, or metrics to any external server.
- **No Cloud Accounts or API Keys:** AgentOpt requires zero authentication and zero external LLM API keys.
- **Inspectable Local State:** All cached repository symbol graphs, session metrics, and cross-session memories are stored as plain, human-readable JSON inside `.agent-opt/` in your workspace and can be wiped at any time via `npx agent-opt uninstall --purge`.
- **Non-Destructive Hook Management:** `aopt init` and `aopt uninstall` preserve any existing user hooks or settings in `.claude/settings.json`, `.cursor/hooks.json`, and `.codex/config.toml`.
