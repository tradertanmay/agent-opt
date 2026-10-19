# Contributing to AgentOpt

Thank you for contributing to **AgentOpt**! Our mission is to make every AI coding agent faster, more accurate, more reliable, and more token-efficient without adding workflow friction or external LLM dependencies.

## Guiding Engineering Principles

1. **Zero Runtime Dependencies:** Do not add third-party npm runtime dependencies or native C++ addons. Use Node.js standard library modules (`node:fs`, `node:crypto`, `node:path`, etc.).
2. **No Extra LLM Calls:** Hooks run synchronously inside the coding agent loop. Keep hook execution deterministic and under `15ms`.
3. **Evidence Over Claims:** Every optimization change must be validated via `npm test` and `npm run benchmark`. Never optimize token consumption at the expense of task completion or correctness.

## Adding a New Agent Platform Adapter

All platform-specific payload normalization and response formatting live in [`src/adapters/index.ts`](./src/adapters/index.ts):

1. Add the platform identifier to `SupportedPlatform` in [`src/types/index.ts`](./src/types/index.ts).
2. Implement stdin payload normalization in `parsePlatformHookPayload()`.
3. Implement stdout/stderr/exitCode formatting in `formatPlatformHookOutput()`.
4. Add non-destructive install/uninstall logic in `installPlatformAdapter()` and `uninstallPlatformAdapter()`.
5. Add unit and round-trip tests in [`src/tests/agent-opt.test.ts`](./src/tests/agent-opt.test.ts).

## Development Workflow

```bash
npm install
npm run typecheck
npm test
npm run demo
npm run benchmark
```
