# SHAPI build plan: milestones and tasks

## Context

SHAPI is a YC Winter 2027 application (deadline Nov 2, 2026, 8pm PT) against the "Self-Maintaining APIs" RFS. Research is done (`research/01-03`). The thesis: every competitor works off what the provider says; SHAPI works off what the API actually does and what the customer's code actually depends on. The product is a 60-second repo scan that produces an `api.lock` dependency map, matched against an advisory database, growing into verified fix PRs.

The folder currently holds only three research docs. No code, no git repo. This plan turns the thesis into ordered milestones we work through together.

## Working agreement

- Repository: https://github.com/SriVarshini09/YC. The local folder `C:\Users\ptula\OneDrive\Desktop\YC\SHAPI` becomes this repo's working copy (init, add remote, pull, commit the existing `research/` docs and this plan as `docs/PLAN.md`).
- Branching: one branch per task, named `m<n>-t<k>-<slug>` (for example `m1-t2-call-site-extractor`). Never commit to main.
- Pull requests: one PR per task against main. The user reviews and merges. Work on the next task starts from the latest main after merge, or stacks on the previous task branch when it depends on unmerged work, and the PR description says so.
- Cadence: run through a whole milestone (opening one PR per task), then pause for review before the next milestone.
- Summaries: each task's PR includes `docs/progress/M<n>-T<k>-<slug>.md`. Short prose, under 15 lines: what exists now, how to run it, what is not done, decisions made. Plus a code block with the run command. `docs/progress/README.md` is the index with one line per task, its PR link, and status.
- Decisions chosen for you: task order starts with the scan CLI (the onboarding demo), canary fleet second. Both get built.

## Stack (lean, chosen once)

Node 22, pnpm workspaces, TypeScript, tsup for builds, vitest for tests, commander for the CLI, ts-morph (TypeScript compiler API wrapper) for the extractor, zod for schemas, better-sqlite3 for the local shape store (Postgres later), Claude API (`claude-fable-5-1`) only inside the repair agent in Milestone 3.

Repo layout:

```
SHAPI/
  packages/
    core/        contracts, api.lock schema, advisory schema, matcher
    extractor/   TypeScript call-site and dependency-surface extraction
    cli/         npx shapi
    shapes/      JSON shape inference, shape store, shape diff
    canary/      provider canary workers and scheduler
    repair/      recipes, contract test generation, repair agent (M3)
    github-app/  PR delivery (M3)
    mcp/         MCP server and agent skill (M4)
  advisories/    seeded advisory JSON files (open format)
  fixtures/      demo repos used in tests and the demo
  docs/progress/ task summaries
  research/      existing docs
```

## Milestone 0: Scaffold (half day)

- T0.1 `git init`, pnpm workspace, TypeScript base config, vitest, lint, `.gitignore`, `docs/progress/README.md`.
- Done when: `pnpm test` runs green on an empty suite and the progress index exists.

## Milestone 1: Scan CLI, the 60-second demo (days 1-4)

- T1.1 Provider registry. `packages/core/providers.json`: ~30 providers mapped by hostname patterns and SDK package names (GitHub/octokit, Stripe, Twilio, Shopify, QuickBooks, Xero, HubSpot, Slack, OpenAI, Anthropic, and others from the research). Zod schema.
- T1.2 Call-site extractor. ts-morph walker that finds HTTP calls (fetch, axios, got, undici, node-fetch) with literal or template URLs, and SDK method calls (`octokit.rest.actions.createWorkflowDispatch`, `stripe.customers.create`). Resolves each to provider + endpoint + method where determinable; marks unresolved ones.
- T1.3 Dependency surface. For each call site: response fields read (property chains on the awaited result), status codes compared (`res.status === 204`, `.ok`), string enum comparisons, request headers set (API version headers). Dataflow is intra-file first; cross-file later.
- T1.4 `api.lock` format and writer. Deterministic JSON: providers, call sites with file:line, endpoint, method, fields, statusCodes, enums, headers. Schema in `packages/core`.
- T1.5 Advisory format and seed. JSON schema for an advisory: provider, endpoint pattern, change class (status-code, field-rename, enum-added, required-field, version-sunset, scope-change, auth), first observed, published notice, effective date, severity, migration note, optional recipe id. Seed `advisories/` with the GitHub workflow_dispatch 204 to 200 case, QuickBooks minor-version fallback, Xero scope removal, Reddit data API closure, Facebook Graph version sunsets, and the top public deadlines from the research.
- T1.6 Matcher. Intersect advisories with `api.lock`: a call site is affected when provider and endpoint match and the dependency surface touches the changed thing (for example, branches on 204). Output: affected call sites with severity and the advisory.
- T1.7 CLI. `shapi scan [path]`: table output (providers found, call sites, affected call sites, upcoming deadlines in 90 days), `--json`, `--out api.lock`, non-zero exit on critical findings. `shapi scan --repo <github url>` clones to a temp dir and scans.
- T1.8 Fixture repo and tests. `fixtures/demo-ts/`: a small TypeScript service calling GitHub workflow_dispatch and checking for 204, plus a Stripe call and a QuickBooks call. Vitest covers extractor, matcher, and CLI output against this fixture.
- Done when: `npx shapi scan fixtures/demo-ts` reports the GitHub call site as affected by the 204 to 200 advisory with file:line, in under 10 seconds.

## Milestone 2: Canary fleet and shape diff (days 5-7)

- T2.1 Shape inference. JSON body to a shape: field paths, types, value classes (enum-like, date, id, numeric sign), null rate, array cardinality. Payload values never stored; field paths hashed with a per-provider salt. Status code and headers captured.
- T2.2 Shape store. SQLite via better-sqlite3: provider, endpoint, method, observed_at, shape hash, shape JSON. Simple queries: latest shape, history.
- T2.3 Canary workers. GitHub (public endpoints plus a token for a SHAPI-owned test repo) and Stripe test mode. Each worker is a list of endpoint probes. Scheduler runs them on an interval and writes shapes.
- T2.4 Shape diff and classification. Old vs new shape: added, removed, type-changed fields, new enum values, status-code change, header change. Classify breaking vs non-breaking vs informational using the same change classes as advisories.
- T2.5 Replay of the GitHub incident. Recorded old (204, no body) and new (200, JSON with run id) responses as fixtures; the diff engine must classify it as a breaking status-code change and emit a draft advisory identical in substance to the seeded one.
- T2.6 Draft advisory from diff. Diff to advisory JSON in `advisories/drafts/` for human review; a reviewed draft moves to `advisories/`.
- Done when: the scheduler runs GitHub and Stripe probes, stores shapes, and the replayed incident produces a draft advisory the Milestone 1 matcher then flags in the fixture repo.

## Milestone 3: Repair and PR delivery (days 8-10)

- T3.1 Recipe format and the first recipe. A recipe is a deterministic code transform tied to a change class. First recipe: status-code set change (accept 200 or 204) via ts-morph.
- T3.2 Contract test generation. From the old and new shapes, generate a vitest test for the affected call site that fails on the new shape before the recipe and passes after. Synthetic values filled into the real schema.
- T3.3 Repair agent. Applies the recipe; for residual call sites the recipe cannot reach, calls Claude with the advisory, the call site, and the shapes, inside a sandboxed working copy; reruns the generated test; rejects the change if the test does not pass.
- T3.4 GitHub App. On advisory match, open a PR: diff, generated test, evidence block (first observed, source canary or tenant count, severity, blast radius).
- Done when: the fixture repo receives a PR with the 204/200 fix and a passing contract test, end to end from the seeded advisory.

## Milestone 4: Agent surface (day 11)

- T4.1 MCP server exposing `scan`, `advisories`, `impact`, `apply_fix`.
- T4.2 Agent skill package installable with `npx skills add shapi` that teaches Claude Code and Cursor to use the server.
- Done when: Claude Code runs the full loop on the fixture repo from the editor.

## Milestone 5: Research and application (parallel, from day 3)

- T5.1 GitHub commit-mining script: public commits fixing third-party API breakage, grouped by provider, with time from provider change to fix. Output CSV plus a one-page summary in `research/04-commit-mining.md`.
- T5.2 Drift observatory v0: probe unauthenticated public endpoints of 50 APIs with published specs, compute spec-vs-reality disagreement, summary in `research/05-observatory.md`.
- T5.3 Application draft in `research/06-yc-application.md` built on the demo and the numbers from T5.1 and T5.2.
- Done when: all three docs exist and the demo video is recorded.

## Verification

- Milestone 1: `pnpm test` green; `npx shapi scan fixtures/demo-ts` shows the GitHub call site flagged with the advisory; `--json` validates against the api.lock schema.
- Milestone 2: `pnpm canary run --once` writes shapes for GitHub and Stripe; `pnpm test` includes the 204 to 200 replay producing a breaking classification and a draft advisory.
- Milestone 3: a test harness runs the repair agent against the fixture, asserts the generated test fails before and passes after, and a PR appears on a SHAPI-owned test repo.
- Milestone 4: a scripted Claude Code session calls the MCP tools and the fix lands in the fixture.
- Every task ends with its `docs/progress` summary and an updated index line.

## Out of scope for now

Python and Go extractors, Postgres and ClickHouse, provider console, OpenTelemetry exporter (Level 2), billing. These follow the demo and the application.
