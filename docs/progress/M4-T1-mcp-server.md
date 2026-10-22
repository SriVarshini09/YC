# M4-T1 MCP server

What exists: `packages/mcp` (`@shapi/mcp`, bin `shapi-mcp`), an MCP server over stdio with four tools. `scan` (read-only) maps a repo's third-party API call sites and matches advisories: affected call sites with file:line and reasons, exposed ones, deadlines in 90 days. `advisories` (read-only) lists advisories, filtered by provider or by upcoming effective date, and marks which have a fix recipe. `impact` (read-only) shows, for one advisory, the affected and exposed call sites and how it would be fixed. `apply_fix` runs the test-first repair: `mode` is `dry-run` (default; returns a unified diff of the fix and the contract test), `write` (edits the repo) or `pr` (opens a pull request); `llm: true` enables the Claude fallback. Each tool returns a short readable summary followed by the details as JSON. Paths resolve against the directory the editor starts the server in; `SHAPI_ADVISORIES` and `SHAPI_DB` override the advisories folder and shape store.
How to run: `pnpm test packages/mcp` (a real MCP client over the SDK's in-memory transport). Smoke-tested over stdio by launching `node packages/mcp/bin/shapi-mcp.js` the way an editor does: tools listed, scan, and a dry-run fix all work, with no stray stdout.
Not done: the agent skill and editor configuration (T4.2); a live Claude Code session.
Decisions: the tool descriptions tell the agent to ask before `write` or `pr`; read-only tools carry `readOnlyHint` so editors can auto-approve them.

```
pnpm test packages/mcp
```
