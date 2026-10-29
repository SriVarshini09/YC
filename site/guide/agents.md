# Coding agents (MCP)

SHAPI ships an MCP server and an agent skill, so Claude Code, Cursor and other MCP clients can check and fix third-party API breakages while they work in your repository.

## Tools

| Tool | What it does |
|---|---|
| `scan` | Map every third-party API call site and match it against the advisories. Read-only. |
| `advisories` | List advisories, filtered by provider or by upcoming deadlines. Read-only. |
| `impact` | For one advisory, list the affected and exposed call sites, with reasons. Read-only. |
| `apply_fix` | Repair test-first. `mode=dry-run` (default) returns the diff; `write` and `pr` change things, and the skill tells the agent to ask you first. |

## Use it today: the CLI

Any coding agent that can run commands can use SHAPI through the CLI, with nothing to install:

```sh
npx shapi-cli scan .                # what's affected, and why
npx shapi-cli fix .                 # a dry run: each fix and the files it would change, nothing written
npx shapi-cli fix . --write         # write the fixes (ask before running this)
```

Tell the agent to use `shapi-cli`, never `shapi`: the npm package named `shapi` is someone else's.

## The MCP server (preview)

The MCP server and the agent skill aren't published yet. To try them early, [open an issue](https://github.com/SriVarshini09/shapi-advisories/issues) or email [sri@shapi.dev](mailto:sri@shapi.dev). Once you have them, register the server with Claude Code (`claude mcp add shapi -- node <path>/packages/mcp/bin/shapi-mcp.js`) or in Cursor's `.cursor/mcp.json`.

Optional environment for the server:

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Lets `apply_fix` use Claude when it's called with `llm=true` and no recipe applies. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Opening PRs (otherwise the `gh` login). |
| `SHAPI_ADVISORIES` | A different advisory folder. |
| `SHAPI_MCP_ANY_PATH` | Set to `1` to let tools work on paths outside the project the server was started in (refused by default). |

Then ask, for example: *"Use SHAPI to check this repository for third-party API breakages and fix what you can."*
