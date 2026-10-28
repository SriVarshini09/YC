# Coding agents (MCP)

SHAPI ships an MCP server and an agent skill, so Claude Code, Cursor and other MCP clients can check and fix third-party API breakages while they work in your repository.

## Tools

| Tool | What it does |
|---|---|
| `scan` | Map every third-party API call site and match it against the advisories. Read-only. |
| `advisories` | List advisories, filtered by provider or by upcoming deadlines. Read-only. |
| `impact` | For one advisory, list the affected and exposed call sites, with reasons. Read-only. |
| `apply_fix` | Repair test-first. `mode=dry-run` (default) returns the diff; `write` and `pr` change things, and the skill tells the agent to ask you first. |

## Set up

The MCP server runs from a clone of the SHAPI repository:

```sh
git clone https://github.com/SriVarshini09/YC.git shapi
cd shapi && pnpm install && pnpm build
```

Register it with Claude Code, using the absolute path to your clone:

```sh
claude mcp add shapi -- node /path/to/shapi/packages/mcp/bin/shapi-mcp.js
```

In Cursor, add the same command to `.cursor/mcp.json`.

Install the skill, which tells the agent when and how to use the tools:

```sh
npx skills add SriVarshini09/YC --skill shapi -a claude-code cursor
```

Optional environment for the server:

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Lets `apply_fix` use Claude when it's called with `llm=true` and no recipe applies. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Opening PRs (otherwise the `gh` login). |
| `SHAPI_ADVISORIES` | A different advisory folder. |

Then ask, for example: *"Use SHAPI to check this repository for third-party API breakages and fix what you can."*
