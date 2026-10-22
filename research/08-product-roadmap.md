# SHAPI product roadmap and effort estimate

Written 2026-10-22, after the production-stack research ([`research/09-production-stack-research.md`](09-production-stack-research.md)). This document compares what exists with what a complete product needs, and estimates the work.

## How to read the estimates

- **Engineer-days** means a focused day of one experienced engineer, normal pace, including tests and review. One engineer-day is about 8 hours.
- **With Claude Code** applies to most coding tasks: I write the code and tests, and you review and merge. In this repo, Milestones 0–4 (about 25 PRs) took roughly one working day, so coding goes several times faster. Not everything speeds up. Testing against real providers, operations, security reviews, customer feedback, legal review and SOC 2 calendar time move at normal speed. So each phase lists both figures.
- **Ranges** are honest uncertainty, not padding. The low end assumes the first approach works.

## Where SHAPI stands today

| Layer | Exists now | Production gap |
|---|---|---|
| Mapping (extractor) | TS/JS via ts-morph; fetch, axios, got, undici, ky, Octokit, Stripe; same-file dataflow | Python, Go, Java; cross-file resolution; type-aware SDK detection |
| Contract and diff | Shape inference, diff, SQLite store | oasdiff for structural checks; statistical drift; Postgres |
| Sensor | GitHub + Stripe canaries, run by hand | Hosted schedule, about 50–100 providers, stable egress IPs, false-positive control; customer traffic hooks |
| Advisory | 7 hand-researched advisories in a custom JSON format | OSV-format database, automated ingestion from changelogs and specs, human review flow, public open data |
| Repair | 1 recipe (status code), Claude fallback | Recipe library (ast-grep), per-language fixers, eval set, multi-candidate loop |
| Verification | Contract tests for `fetch` only; temp-folder "sandbox" on the same machine | Firecracker microVM sandbox with egress off; SDK and axios tests; Python/Go/Java harnesses |
| Delivery | PRs through your `gh` token; MCP server and skill | Real GitHub App: webhooks, queue, check runs, noise controls, dashboard; GitLab later |
| Backend | None (local CLI only) | Postgres with tenants, job engine, hosting, secrets, monitoring, auth, billing |
| Product surface | CLI, MCP | Web app (findings, PRs, settings), docs site, npm package, Slack |
| Trust and compliance | None | Code-handling policy, security page, SOC 2, DPA |

## Phase A: first paying customer (the product works safely on real repos)

| Work | Engineer-days |
|---|---|
| GitHub App: registration, webhook ingress with signature check, Postgres queue, redelivery sweeper, installation tokens, check runs, PR caps, deterministic branches, dashboard issue, platform interface | 8–10 |
| Hosted backend: Postgres schema with row-level security, Trigger.dev or Hatchet jobs, Fly.io deploy with static IPs, Doppler secrets, Sentry/OTel monitoring, CI/CD | 6–8 |
| Real sandbox: E2B or Daytona microVM, egress off, caching registry proxy, short-lived read-only tokens, no secrets inside | 5–7 |
| Web app (minimal): GitHub login, org and repo list, findings, PR history, noise settings, Stripe billing | 8–12 |
| Distribution: publish `shapi` to npm, public advisory repo, docs site | 3–4 |
| Security basics: code-handling policy, privacy policy, terms, DPA template, security page | 3–5 (legal review is outside work) |
| **Total** | **33–46 engineer-days** (about 7–9 weeks for one engineer; about 2–3 weeks with Claude Code) |

## Phase B: coverage and fix quality (customers keep it installed)

| Work | Engineer-days |
|---|---|
| Embed oasdiff; project shapes to OpenAPI response schemas | 4–6 |
| Statistical drift detection (presence and null rates, sample gates, multi-probe confirmation) | 5–7 |
| Contract tests for SDK, axios and got call sites (HTTP-level stubs with msw or nock) | 5–7 |
| Recipe engine on ast-grep YAML plus 6–8 recipes (field rename, enum handling, URL version bump, header version bump, query parameter, status set, scope config), each with fixture tests | 10–15 |
| Repair loop upgrade: tool loop with locked tests, multiple candidates, smallest passing diff wins, eval set from the mined commits, quality metrics | 6–8 |
| Advisory pipeline: OSV format, adapters for Stripe, Shopify, Meta, OpenAI, Anthropic and GitHub, LLM extraction from page diffs with a verbatim-quote check, review flow, about 50 providers covered | 12–18 |
| Canary fleet: 20+ providers on a schedule, static IPs, OAuth token refresh with locks, alerting that separates outages from real changes | 8–12 |
| **Total** | **50–73 engineer-days** (about 10–15 weeks; about 4–6 weeks with Claude Code) |

## Phase C: multi-language and traffic sensing (the moat)

| Work | Engineer-days |
|---|---|
| Python extractor (ast-grep plus Pyright) plus a respx/responses test harness | 12–18 |
| Go extractor (ast-grep plus go/types) plus an httptest harness | 10–14 |
| Java extractor (ast-grep plus JavaParser) plus a WireMock harness | 12–18 |
| In-process shape sensor for Node and Python, ingestion API, collector redaction guide, overhead benchmark | 10–14 |
| Shape sensor for Go and Java | 8–12 |
| Cross-customer corroboration plus a "Fix Confidence" score from merge outcomes | 5–8 |
| **Total** | **57–84 engineer-days** (about 12–17 weeks; about 5–8 weeks with Claude Code) |

## Phase D: enterprise and scale (runs alongside, driven by customers)

| Work | Engineer-days |
|---|---|
| GitLab support (behind the platform interface); Bitbucket later | 8–10 each |
| SSO and SCIM (WorkOS), roles, audit log | 6–8 |
| "Run in your own CI" tier (the generated test runs in the customer's GitHub Actions) | 5–7 |
| Slack and Teams app (digests, not one message per PR) | 4–6 |
| SOC 2 controls engineering | 8–12, plus 2–3 months to Type I and 3–12 months of observation for Type II; about $20–60k in year one |
| Provider console (shows a provider which customers a planned change breaks) | 15–25 |
| GitHub Marketplace paid listing (needs 100 installs and a verified publisher) | 2–3 |
| **Total** | **about 56–81 engineer-days** plus SOC 2 calendar time |

## Totals

| Milestone | Engineer-days | One engineer | With Claude Code (you review) |
|---|---|---|---|
| Phase A: first paying customer | 33–46 | 7–9 weeks | 2–3 weeks |
| Through Phase B: product customers keep | 83–119 | 4–6 months | 6–9 weeks |
| Through Phase C: full vision (multi-language plus traffic) | 140–203 | 7–10 months | 3–4 months |
| Everything, including Phase D | 196–284 (about 1,600–2,300 engineer-hours) | 10–14 months | 5–7 months, plus SOC 2 calendar time |

## What can't be compressed

- **Real-world tuning.** False positives in drift detection and wrong fixes show up only on real customer repos and live provider traffic. Budget design-partner weeks, not just build days.
- **External waits.** SOC 2 observation windows, Marketplace's 100-install threshold, legal review of provider terms for probing and for republishing change data, and provider sandbox approvals (some take days).
- **Your review time.** Every PR goes through you, so the Claude Code figures assume you can review a few PRs a day.

## Recommended order

1. Phase A in full, because the GitHub App and the real sandbox are prerequisites for any customer.
2. Phase B's oasdiff, SDK contract tests and the advisory pipeline next, because they decide whether fixes cover real code and whether the database stays fresh.
3. Recipes and the canary fleet as coverage demands.
4. Phase C languages in the order your first customers need (Python first, most likely).
5. Phase D items only when a customer asks.

## Decisions needed before Phase A

1. **Hosting and vendors:** Fly.io plus Trigger.dev or Hatchet plus E2B is the recommended starting stack, about $100–250 a month before LLM spend.
2. **Open or closed:** the research suggests an open advisory database and scanner with a hosted product on top (Renovate's model). That means making some or all of this repo public.
3. **Pricing model:** per repo, per integration, or per developer.
4. **Design partners:** two or three teams with many integrations willing to install the GitHub App early. Nothing improves quality faster.
