# AgentOpt — Configuration Reference (`.agent-opt/config.json`)

AgentOpt stores its per-repository configuration in `.agent-opt/config.json`. All settings have safe defaults and can be switched via `aopt mode <FAST|BALANCED|STRICT>` or edited directly in `.agent-opt/config.json`.

---

## 1. Selectable Optimization Modes (`mode`)

| Mode | Default? | Context Ranking & Slice Injection | Redundant Read/Write & Loop Guard | `Stop` Verification Gate |
|---|---|---|---|---|
| **`FAST`** | **Yes (Default)** | Enabled (`<= 650` tokens) | Enabled | Disabled (`0` Stop continuations) |
| **`BALANCED`** | Optional (`aopt mode BALANCED`) | Enabled (`<= 650` tokens) | Enabled | Runs a silent `<2s` in-hook test probe when source files are modified; releases immediately if tests pass (`0` extra LLM turns) and blocks only on real test/requirement failures |
| **`STRICT`** | Optional (`aopt mode STRICT`) | Enabled (`<= 650` tokens) | Enabled | Requires explicit agent test execution after source edits (up to `2` Stop blocks/session) |

Switch modes at any time without losing custom settings:
```bash
aopt mode FAST
aopt mode BALANCED
aopt mode STRICT
```

---

## 2. Default `.agent-opt/config.json` Schema (`FAST` Mode)

```json
{
  "enabled": true,
  "mode": "FAST",
  "context": {
    "enabled": true,
    "maxRankedFiles": 8,
    "maxRepoMapTokens": 650,
    "deduplicateReads": true,
    "blockRedundantFullReadsAfter": 2,
    "minQuerySpecificityForInjection": true
  },
  "verification": {
    "enabled": false,
    "enforceOnStop": false,
    "autoRunFastTestsOnStop": false,
    "maxStopBlocksPerSession": 0,
    "requireTestsWhenCodeModified": true,
    "exemptDocOnlyChanges": true
  },
  "failureDetection": {
    "enabled": true,
    "maxRepeatedCommandFailures": 2,
    "maxIdenticalErrors": 2,
    "maxRedundantReadsOfUnchangedFile": 2,
    "detectEditOscillation": true
  },
  "memory": {
    "enabled": true,
    "maxEntries": 50,
    "minConfidenceToInject": 0.7,
    "autoPruneContradictions": true
  }
}
```

---

## 3. Field-by-Field Reference

### Top-Level Fields
- `enabled` (`boolean`, default: `true`): Master switch for all AgentOpt hooks. Toggle with `aopt enable` / `aopt disable`.
- `mode` (`"FAST" | "BALANCED" | "STRICT"`, default: `"FAST"`): Active optimization preset.

### `context` Section
- `context.enabled` (`boolean`, default: `true`): Enables AST symbol/dependency ranking and `PreInvocation`/`UserPromptSubmit` context map injection.
- `context.maxRankedFiles` (`number`, default: `8`): Maximum candidate files scored per query before distractor pruning.
- `context.maxRepoMapTokens` (`number`, default: `650`): Hard token ceiling for injected context maps and inline slices.
- `context.deduplicateReads` (`boolean`, default: `true`): Tracks SHA-256 hashes of read files in the current session to prevent redundant back-to-back full-file reads of unchanged files.
- `context.blockRedundantFullReadsAfter` (`number`, default: `2`): Blocks consecutive full-file reads of an unchanged file on the $N$-th immediate repeat (never blocks targeted line-range reads or reads after intervening tool calls).
- `context.minQuerySpecificityForInjection` (`boolean`, default: `true`): Skips context injection on generic conversational prompts (e.g., `"hi"`, `"thanks"`).

### `verification` Section
- `verification.enabled` (`boolean`, default: `false` in `FAST`, `true` in `BALANCED`/`STRICT`): Enables task verification tracking.
- `verification.enforceOnStop` (`boolean`, default: `false` in `FAST`, `true` in `BALANCED`/`STRICT`): Enables the `Stop` hook verification gate.
- `verification.autoRunFastTestsOnStop` (`boolean`, default: `false` in `FAST`/`STRICT`, `true` in `BALANCED`): When `true`, runs a silent `<2s` test probe inside the `Stop` hook when dirty source files exist so passing edits finish immediately without an extra LLM turn.
- `verification.maxStopBlocksPerSession` (`number`, default: `0` in `FAST`, `2` in `BALANCED`/`STRICT`): Hard upper bound on `Stop` continuations per session to guarantee loop safety.
- `verification.requireTestsWhenCodeModified` (`boolean`, default: `true`): Requires test evidence when implementation files are modified and a runnable test suite exists.
- `verification.exemptDocOnlyChanges` (`boolean`, default: `true`): Exempts documentation-only edits (`.md`, `.txt`, `LICENSE`) from test gates.

### `failureDetection` Section
- `failureDetection.enabled` (`boolean`, default: `true`): Enables loop and failure detection across `PreToolUse` and `PostToolUse`.
- `failureDetection.maxRepeatedCommandFailures` (`number`, default: `2`): Blocks re-running the exact same failing shell command when no source file has been modified in between.
- `failureDetection.maxIdenticalErrors` (`number`, default: `2`): Injects diagnostic guidance when identical tool error signatures repeat.
- `failureDetection.maxRedundantReadsOfUnchangedFile` (`number`, default: `2`): Threshold for flagging unproductive file-reading loops.
- `failureDetection.detectEditOscillation` (`boolean`, default: `true`): Detects `A -> B -> A` SHA-256 edit oscillation loops on the same file.

### `memory` Section
- `memory.enabled` (`boolean`, default: `true`): Enables the local SHA-256-anchored project memory store (`.agent-opt/memory/project-memory.json`).
- `memory.maxEntries` (`number`, default: `50`): Maximum stored project memories.
- `memory.minConfidenceToInject` (`number`, default: `0.7`): Minimum confidence score (`0.0–1.0`) required before a memory entry is injected into prompt context.
- `memory.autoPruneContradictions` (`boolean`, default: `true`): Automatically invalidates memories when `package.json`/`pyproject.toml` SHA-256 hashes change or when a command fails with `missing script`/`command not found`.
