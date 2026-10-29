# Using SHAPI from Claude Code and Cursor

SHAPI ships an MCP server (`packages/mcp`, tools `scan`, `advisories`, `impact`, `apply_fix`) and an agent skill (`.claude/skills/shapi/SKILL.md`) that tells the agent when and how to use it: scan, explain, dry-run the fix, and write or open a PR only after you say so.

## In this repository

Nothing to install. After `pnpm install`:

- **Claude Code** reads `.mcp.json` (asks you once to approve the `shapi` server) and `.claude/skills/shapi`.
- **Cursor** reads `.cursor/mcp.json`; the skill installs with the command below.

Try: *"Use SHAPI to check fixtures/demo-ts for third-party API breakages and fix what you can."*

## In another repository

1. Install the skill (the installer reads it from SHAPI's GitHub repository, with your `gh` login when the repository needs one):

   ```bash
   npx skills add SriVarshini09/YC --skill shapi -a claude-code cursor
   ```

2. Register the MCP server, pointing at your SHAPI checkout. Claude Code:

   ```bash
   claude mcp add shapi -- node <path-to-shapi>/packages/mcp/bin/shapi-mcp.js
   ```

   Cursor: add the same `command`/`args` to `.cursor/mcp.json` in that repo, with the absolute path.

Optional environment for the server: `ANTHROPIC_API_KEY` (lets `apply_fix` use Claude when no recipe applies), `GITHUB_TOKEN` (otherwise the `gh` login is used for PRs), `SHAPI_DB` (canary shape store), `SHAPI_ADVISORIES` (advisory folder), `SHAPI_MCP_ANY_PATH=1` (allow `path` arguments outside the project; refused by default).
