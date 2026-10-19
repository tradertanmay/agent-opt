# AgentOpt Optimization Rules

- Prefer reading targeted line slices (`StartLine`/`EndLine` or `offset`/`limit`) suggested by `[AgentOpt Context Map]` over reading entire large files.
- Do not re-read unchanged files that are already in your current session context.
- When modifying recursive functions or state constants, verify variable names and recursive calls before writing.
