<p align="center">
  <a href="https://shapi.dev/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="brand/motion/shapi-logo-animated-dark.svg">
      <img src="brand/motion/shapi-logo-animated-light.svg" alt="SHAPI" height="64">
    </picture>
  </a>
</p>

Self-maintaining APIs. SHAPI maps the third-party APIs a codebase depends on (`api.lock`: every call site, and the status codes, fields, enums, headers and query params each one relies on) and flags the call sites that a known breaking change actually hits.

Documentation: https://shapi.dev/

## Try it

Requires Node 22.14 or later (not 23 or 25) and pnpm.

```bash
pnpm install
```

```bash
pnpm exec shapi scan fixtures/demo-ts
```

(In this repository `pnpm exec shapi` runs the local build. Anywhere else use `npx shapi-cli`: the npm package named `shapi` is not SHAPI.)

The demo flags `src/deploy.ts`, which throws unless `res.status` is exactly 204 from GitHub's workflow_dispatch endpoint (it started answering 200), plus a QuickBooks call pinned to minor version 65 and a HubSpot v1 call with a deadline on 2026-12-04. The command exits 1 because a critical finding exists (`--fail-on none` to disable).

Other flags: `--json`, `--out api.lock`, `--repo <git url>`, `--advisories <dir>`.

## Fix it

```bash
pnpm exec shapi fix fixtures/demo-ts
```

For each affected TypeScript, JavaScript or Python call site whose advisory has a fix recipe, `shapi fix` generates a contract test (from the advisory's fix, or from recorded before/after responses), confirms it fails, applies the recipe (or asks Claude with `--llm` when no recipe fits), and keeps the change only if the test then passes. Other call sites are reported with the provider's migration steps; Python gets the `apply-fix` and `status-code-accept-set` recipes, not Claude, for now. `--write` writes the fix into the repo; `--pr` opens a pull request with the fix, the test and the evidence (`--repo <github url> --pr` works on a repo you haven't cloned). [What a fix PR contains](https://shapi.dev/guide/fixes#what-a-fix-pr-contains).

## Use it from your editor

Claude Code and Cursor pick up the `shapi` MCP server (`.mcp.json`, `.cursor/mcp.json`) and the `shapi` agent skill (`.claude/skills/shapi`) when this repo is open. Ask: *"Use SHAPI to check fixtures/demo-ts for third-party API breakages and fix what you can."* For other repositories, see [docs/agents.md](docs/agents.md).

## Watch providers

```bash
pnpm canary run --once
```

Canary probes call provider APIs, store response shapes in `.shapi/shapes.db` (Postgres on the hosted worker, hourly), and draft an advisory into `advisories/drafts/` when a shape changes in a breaking way. A rate-limited answer, or a key the provider rejects, is reported as a probe error and not recorded. Every probe is a free read, except Twilio's, which uses test credentials and sends nothing:

| Provider | Probes | Needs |
|---|---|---|
| GitHub | rate limit, a public repo, workflows, one workflow's latest successful run; workflow_dispatch on a test repo | nothing; `SHAPI_GITHUB_TOKEN`, `SHAPI_CANARY_REPO`, `SHAPI_CANARY_WORKFLOW` for the dispatch |
| Slack | `api.test`; `auth.test`, `conversations.list` | nothing; `SHAPI_SLACK_BOT_TOKEN` (xoxb-, `channels:read`) |
| Stripe | balance, customers, payment intents | `SHAPI_STRIPE_TEST_KEY` (test mode only) |
| OpenAI | list models | `SHAPI_OPENAI_API_KEY` |
| Anthropic | list models | `SHAPI_ANTHROPIC_API_KEY` |
| Twilio | create a message from the magic test number | `SHAPI_TWILIO_TEST_ACCOUNT_SID`, `SHAPI_TWILIO_TEST_AUTH_TOKEN` (test credentials) |
| HubSpot | contacts, deal pipelines | `SHAPI_HUBSPOT_TOKEN` (a test account's private-app token) |

## Layout

- `packages/core`: provider registry, api.lock and advisory schemas, matcher
- `packages/extractor`: call-site and dependency-surface extraction for TypeScript/JavaScript (ts-morph) and Python (tree-sitter)
- `packages/shapes`: response shape inference, shape store (SQLite for the CLI, Postgres for the hosted service), shape diff
- `packages/canary`: canary workers, scheduler, replay, draft advisories
- `packages/repair`: recipes, contract test generation, repair agent (Claude fallback)
- `packages/github-app`: pull request delivery and the dashboard issue (GitHub App, or a token for `shapi fix --pr`)
- `packages/mcp`: MCP server for coding agents (`scan`, `advisories`, `impact`, `apply_fix`)
- `packages/cli`: `shapi` command (published to npm as `shapi-cli` by `packages/cli/scripts/build-npm.ts`)
- `packages/db`: the hosted service's Postgres schema, migrations and queries
- `packages/sandbox`: the isolated microVM (E2B) where the hosted service installs dependencies and runs contract tests
- `apps/server`: the hosted service: web app, GitHub App webhooks, worker, and the docs site on shapi.dev
- `advisories/`: seeded advisories (open JSON format)
- `fixtures/demo-ts`: demo service
- `site/`: documentation site (VitePress), built into the server image and served at https://shapi.dev
- `docs/progress/`: one summary per task

## License

The `shapi-cli` package, `packages/cli` and the libraries it bundles, is licensed under [Apache-2.0](packages/cli/LICENSE). The rest of this repository, including the hosted service in `apps/server`, is not licensed for reuse.
