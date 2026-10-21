# SHAPI build plan: onboarding-first

Written 2026-10-21. Supersedes the sequencing in 02-product-thesis.md. The architecture stays; the order and the entry point change.

## 0. The constraint that shapes everything

First value in under 60 seconds, with nothing installed and no traffic captured. Every later layer is an upgrade the user chooses because the previous layer already paid off. Competitors require either a provider-side spec (Bump, oasdiff), their adapter in your data path (Merge, Superglue), or manual API registration (APIDrift, DeprecationWatch). None of them can look at a repo and say something true about it immediately. That is the opening.

## 1. The onboarding ladder

| Level | Time | What the user does | What they get | Why they climb |
|---|---|---|---|---|
| 0 | 30-60s | `npx shapi scan` in a repo, or paste a public GitHub URL | `api.lock`: every third-party API, every call site, which fields/status codes/enums each one depends on. Matched against the public advisory DB: "3 of your 14 APIs have deadlines in 90 days; 2 call sites branch on a status code that changed." Shareable report and badge. | Free, instant, true. The first honest "what do we actually depend on" most teams have ever seen. |
| 1 | 2 min | Install the GitHub App | Watches the repo. When an advisory matches `api.lock`, opens a PR with a codemod and a contract test that fails before and passes after. Slack alert with blast radius. | Fixes arrive instead of alerts. |
| 2 | 1 line | Add the OTel exporter or client middleware, or point an existing OTel collector at SHAPI | Observed contract from real traffic. Silent-change detection in minutes. Fix PRs verified against the team's own traffic shapes. | "Your PRs are now tested against what the API actually returns to you." |
| 3 | install a skill | `npx skills add shapi` or add the SHAPI MCP server | Claude Code, Cursor, Codex can ask: what does this repo depend on, is anything breaking, apply the fix. | Rides the coding-agent distribution wave instead of fighting it. |
| 4 | provider signs up | Provider console | "This change hits 340 call sites across 57 customers; here are the three code patterns." Push verified PRs to opted-in customers. | Nobody can give providers this today. |

Level 0 is the demo, the growth loop, and the application story. Levels 1-2 are the revenue. Level 4 is the moat extension.

## 2. Solving cold start without customers

The observed contract needs traffic. On day one there is none. Two assets fix this and are themselves unique:

1. Canary fleet. SHAPI-owned test accounts on the top 100 APIs (Stripe test mode, GitHub, Shopify dev store, QuickBooks sandbox, HubSpot dev portal, Slack, Twilio, OpenAI, Anthropic, and so on). A scheduler exercises every documented endpoint daily and records response shapes. This catches the GitHub 204->200 class with zero customers. Changelog monitors cannot do this; they only read what the provider wrote.
2. Public drift observatory. For unauthenticated public endpoints, the same probing, published as a public spec-vs-reality score per API. Press and inbound. Seeds the advisory DB.

Customer traffic at Level 2 adds coverage of endpoints and tenants the canaries do not reach, and adds the fleet-wide corroboration signal. The network effect compounds on top of a base that already works.

## 3. Layers and the agent in each

| Layer | What it is | The unique part | Agent or deterministic? |
|---|---|---|---|
| Sensor | Canary fleet, OTel shape exporter, client middleware, spec/changelog/SDK-release ingestion | Canaries and shape-only capture (no payloads leave the VPC) | Deterministic |
| Contract | Published, observed, usage contracts; shape diff; semantic-drift stats; cross-tenant corroboration | Three-way diff; statistical semantic drift (enum sets, null rates, sign conventions) | Deterministic |
| Mapping | Usage extractor: tree-sitter + ast-grep + dataflow per language; LLM only for dynamic URLs and untyped code | `api.lock` as a versioned artifact | Mostly deterministic, LLM for residuals |
| Advisory | Open machine-readable API change advisory DB with codemod recipes, modeled on GHSA | Open format others can publish to | Deterministic store, LLM drafts advisories from observed diffs for human review |
| Repair agent | Takes advisory + `api.lock` match, applies the recipe, Claude handles residual call sites, runs in a sandboxed container, writes the contract test, opens the PR | Recipe once, reuse across every repo; PR carries evidence (first seen, tenants, failing-then-passing test) | Agent, bounded by recipe and test |
| Verification | Replay fixtures from recorded shapes; live run against provider sandbox where available | The PR is trusted because the test is, not because the model is | Deterministic |
| Interface | CLI, GitHub App, Slack, MCP server, agent skill, provider console | Meets the developer where they already are | n/a |

The only place an LLM sits in the critical path is the repair agent, and it is boxed in on both sides: a recipe tells it what to change, a generated test tells it whether it succeeded. That is the answer to "not an LLM wrapper."

## 4. What is unique versus every competitor class, in one line each

- Changelog monitors: they read announcements; SHAPI observes behavior via canaries and traffic, and knows your call sites.
- Spec diffing: they trust the spec; SHAPI diffs the spec against reality.
- Unified APIs: they maintain their adapter; SHAPI maintains your code with no adapter and no lock-in.
- Runtime self-healers: they mutate behavior in the data path at runtime; SHAPI changes code through a reviewed PR with a test.
- Dependabot + agents: they trigger on package versions and rely on your mocked tests; SHAPI triggers on observed API behavior and brings its own contract tests.
- Provider skills: prose for the top 20 vendors; SHAPI is machine-readable, long-tail, and knows the customer's code.
- Generic coding agents: SHAPI feeds them the advisory and the impact map through MCP instead of competing with them.

## 5. Tech stack

- CLI and scanner: TypeScript, tree-sitter grammars, ast-grep rules. TypeScript and Python first, then Go and Java.
- Shape exporter: OpenTelemetry instrumentation hooks for Node (undici/fetch/axios) and Python (requests/httpx); JSON Schema inference with value classes; field-path hashing.
- Canary fleet: scheduled workers (Temporal or a simple cron on Fly/Cloud Run), one adapter per provider sandbox, shapes into the contract store.
- Contract store and stats: Postgres for contracts and advisories; ClickHouse for shape and value-distribution time series.
- Repair agent: Claude (claude-fable-5-1 for recipe synthesis and residuals), running in isolated containers (Firecracker or E2B style), ast-grep/jscodeshift/OpenRewrite recipes.
- Verification: generated Vitest/pytest contract tests; provider sandbox runners.
- Delivery: GitHub App (Probot), Slack app, MCP server, Agent Skill package.
- Advisory DB: public repo plus API, JSON Schema for the advisory format.

## 6. Research to run in parallel, and publish

1. GitHub commit mining: public commits fixing third-party API breakage, per provider, with time from provider change to fix. The first real "hours lost" number.
2. Drift observatory results for the top 200 public APIs: how many disagree with their own spec today.
3. 15-20 interviews with teams running 10+ integrations, scripted around their last incident.

## 7. Ten-day plan, re-ordered for onboarding

Days 1-3: `npx shapi scan` for TypeScript. tree-sitter + ast-grep call-site extraction, field and status-code dependency, `api.lock` output, matched against a hand-seeded advisory DB containing the GitHub 204->200 case and the top 20 upcoming deadlines from public trackers. This is the demo moment.
Days 4-5: canary worker for GitHub and one more provider (Stripe test mode), shape store, shape diff. Show the 204->200 diff reproduced from canary data.
Days 6-8: GitHub App. Advisory matches `api.lock`, applies the status-code recipe, generates the Vitest contract test, opens the PR with evidence.
Day 9: MCP server exposing scan, advisories, and apply-fix, so Claude Code can run the whole loop from the editor.
Day 10: record the demo end to end, run the commit-mining script, write the application.

## 8. Metrics that prove it is working

- Time from provider change to advisory (target: minutes via canaries, not days via changelogs).
- Scan-to-first-PR conversion (Level 0 to Level 1).
- PR merge rate without edits (the trust metric).
- Call sites covered by observed contract (Level 2 adoption).
- Providers with a console account (Level 4).
