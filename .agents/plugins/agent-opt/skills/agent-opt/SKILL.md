---
name: agent-opt
description: Inspect and control the AgentOpt optimization layer (FAST, BALANCED, STRICT modes, ranked AST context maps, verification status, and session telemetry).
---

# AgentOpt Skill Guide

Use the `aopt` / `npx agent-opt` CLI to inspect or configure AgentOpt in the current workspace:

- `npx agent-opt status` — View active mode (`FAST` default, `BALANCED`, `STRICT`), indexed files, installed platforms, and token savings.
- `npx agent-opt mode <FAST|BALANCED|STRICT>` — Switch optimization mode while preserving custom settings.
- `npx agent-opt context "<task prompt>"` — Preview the ranked symbol & dependency context map for a task.
- `npx agent-opt doctor` — Validate hook configurations, manifest health, and repository index.
