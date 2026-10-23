# SHAPI

Self-maintaining APIs. SHAPI maps the third-party APIs a codebase depends on (`api.lock`: every call site, and the status codes, fields, enums, headers and query params each one relies on) and flags the call sites that a known breaking change actually hits.

Documentation: https://srivarshini09.github.io/YC/

## Try it

Requires Node 22+ and pnpm.

```bash
pnpm install
```

```bash
npx shapi scan fixtures/demo-ts
```

The demo flags `src/deploy.ts`, which requires `res.status === 204` from GitHub's workflow_dispatch endpoint (it started answering 200), plus a QuickBooks call pinned to minor version 65 and a HubSpot v1 call with a deadline on 2026-12-04. The command exits 1 because a critical finding exists (`--fail-on none` to disable).

Other flags: `--json`, `--out api.lock`, `--repo <git url>`, `--advisories <dir>`.

## Fix it

```bash
npx shapi fix fixtures/demo-ts
```

For every affected call site, `shapi fix` generates a contract test from the before/after response shapes, confirms it fails, applies the advisory's recipe (or asks Claude with `--llm`), and keeps the change only if the test then passes. `--write` writes the fix into the repo; `--pr` opens a pull request with the fix, the test and the evidence (`--repo <github url> --pr` works on a repo you haven't cloned). Example: [shapi-demo PR #2](https://github.com/SriVarshini09/shapi-demo/pull/2).

## Use it from your editor

Claude Code and Cursor pick up the `shapi` MCP server (`.mcp.json`, `.cursor/mcp.json`) and the `shapi` agent skill (`.claude/skills/shapi`) when this repo is open. Ask: *"Use SHAPI to check fixtures/demo-ts for third-party API breakages and fix what you can."* For other repositories, see [docs/agents.md](docs/agents.md).

## Watch providers

```bash
pnpm canary run --once
```

Canary probes call provider APIs, store response shapes in `.shapi/shapes.db` (Postgres on the hosted worker, hourly), and draft an advisory into `advisories/drafts/` when a shape changes in a breaking way. Every probe is a free read, except Twilio's, which uses test credentials and sends nothing:

| Provider | Probes | Needs |
|---|---|---|
| GitHub | rate limit, a public repo, workflows, runs; workflow_dispatch on a test repo | nothing; `SHAPI_GITHUB_TOKEN`, `SHAPI_CANARY_REPO`, `SHAPI_CANARY_WORKFLOW` for the dispatch |
| Slack | `api.test`; `auth.test`, `conversations.list` | nothing; `SHAPI_SLACK_BOT_TOKEN` (xoxb-, `channels:read`) |
| Stripe | balance, customers, payment intents | `SHAPI_STRIPE_TEST_KEY` (test mode only) |
| OpenAI | list models | `SHAPI_OPENAI_API_KEY` |
| Anthropic | list models | `SHAPI_ANTHROPIC_API_KEY` |
| Twilio | create a message from the magic test number | `SHAPI_TWILIO_TEST_ACCOUNT_SID`, `SHAPI_TWILIO_TEST_AUTH_TOKEN` (test credentials) |
| HubSpot | contacts, deal pipelines | `SHAPI_HUBSPOT_TOKEN` (a test account's private-app token) |

## Layout

- `packages/core`: provider registry, api.lock and advisory schemas, matcher
- `packages/extractor`: TypeScript/JavaScript call-site and dependency-surface extraction (ts-morph)
- `packages/shapes`: response shape inference, shape store (SQLite), shape diff
- `packages/canary`: canary workers, scheduler, replay, draft advisories
- `packages/repair`: recipes, contract test generation, repair agent (Claude fallback)
- `packages/github-app`: pull request delivery (token now, GitHub App later)
- `packages/mcp`: MCP server for coding agents (`scan`, `advisories`, `impact`, `apply_fix`)
- `packages/cli`: `shapi` command
- `advisories/`: seeded advisories (open JSON format)
- `fixtures/demo-ts`: demo service
- `site/`: documentation site (VitePress, published to GitHub Pages)
- `docs/progress/`: one summary per task

## License

The `shapi-cli` package, `packages/cli` and the libraries it bundles, is licensed under [Apache-2.0](packages/cli/LICENSE). The rest of this repository, including the hosted service in `apps/server`, is not licensed for reuse.
