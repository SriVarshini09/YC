# SHAPI product thesis: the observed-contract engine

Written 2026-10-21. Companion to 01-market-research.md.

## 1. How the market solves it today, one level down

Every current approach works off what the provider SAYS, not what the API DOES.

| Approach | Signal it uses | Why it misses |
|---|---|---|
| Changelog monitors (APIDrift, DeprecationWatch) | Docs HTML, release notes | GitHub 204->200 had no changelog. QBO minor-version fallback was silent. Zero knowledge of your code. |
| Spec diffing (oasdiff, Bump.sh, Speakeasy) | OpenAPI v1 vs v2 | The spec is the provider's claim. GitHub's spec still said 204 while reality was 200. |
| Unified APIs (Merge, Nango, Apideck) | Humans + agents maintaining THEIR adapter | Lock-in to their schema. They maintain their code, never yours. |
| Runtime self-healers (Superglue, Refold) | LLM regenerates mapping at runtime on failure | Nondeterminism in the data path. "Healing" a semantic change returns 200 with wrong data. Unauditable. |
| Dependabot + agents | Package manifest version bump, then fix failing tests | API behavior changes without an SDK bump. Your tests mock the third party, so nothing fails. |
| Provider skills (Stripe upgrade-stripe) | Prose migration guide | Top 20 vendors only. Provider cannot see your code. No verification. |

The LLM-wrapper version of this RFS fails in three places: it reads changelogs (lagging and incomplete), it guesses impact (grep for "stripe"), and it emits unverified diffs. Nobody would merge that PR.

## 2. The insight

The ground truth of an API's behavior exists in exactly one place: the traffic between consumer code and the provider. And the right unit of analysis is not "the API" but "the contract this code actually depends on": the specific fields read, status codes branched on, enum values handled, headers consumed, at each call site.

Hold three contracts and diff them:

1. USAGE contract (static). Extracted from the customer's code per call site: endpoint, method, fields read from the response, status codes handled, enum cases covered, pagination style, auth flow, rate-limit headers consumed.
2. OBSERVED contract (dynamic). Extracted from real traffic: response shape per endpoint (schema and value classes, never payloads), status-code distribution, enum value sets, null rates, header presence. Aggregated across all customers into one live "true spec" per provider.
3. PUBLISHED contract. OpenAPI specs, changelogs, SDK diffs, deprecation headers. What everyone else uses. Useful mainly for UPCOMING deadlines, not landed changes.

Diffs that matter:
- PUBLISHED vs OBSERVED = spec drift (the GitHub case).
- OBSERVED(t) vs OBSERVED(t-1) = silent change, detected minutes after it lands because some customer's traffic sees it first.
- (any change) intersect USAGE = impact: exactly which call sites in which repos break, with severity.

The fleet-wide observed contract is the moat. More customers means faster detection. A changelog scraper can never catch a change the provider did not write down.

## 3. What to build

### A. Shape extractor (the sensor)
- Middleware for common HTTP clients (fetch/axios/undici, requests/httpx, net/http, OkHttp) plus an OpenTelemetry exporter so teams already on OTel add one line.
- Optional egress sidecar (proxy or eBPF) for zero-code capture.
- Emits JSON-Schema-style shapes with value classes (string/enum/int/date/null) and hashed field paths. Payload values never leave the customer VPC. This is the privacy story and the adoption story.

### B. Usage extractor (the map)
- tree-sitter + ast-grep/Semgrep rules per language to locate call sites; dataflow to find which response fields are read and which status codes are branched on.
- LLM only to resolve dynamic URLs, string-built paths, and untyped languages. Deterministic first, LLM for residuals.
- Output: a per-repo dependency surface, versioned in git as a lockfile (`api.lock`). This file alone is useful: it is the first honest answer to "what do we actually depend on."

### C. Drift engine (the brain, not an LLM)
- Shape diffs: added/removed/renamed fields, type changes, new enum values, status code changes, header changes.
- Semantic drift via distribution shift: enum value sets, null rates, sign conventions, page sizes, timestamp formats. Statistical, not generative. This catches the class nobody else catches: schema unchanged, meaning changed.
- Cross-customer corroboration before alerting (two or more tenants see the same shift) to kill false positives.

### D. Fix engine (deterministic codemods first)
- Each breaking-change class maps to a codemod recipe: field rename, status-code set, enum case added, required field added, version header bump, scope change, pagination style. ast-grep / jscodeshift / OpenRewrite for JVM.
- LLM (Claude) synthesizes a recipe from a change descriptor when none exists, and handles residual call sites a recipe cannot reach. Every generated recipe is reviewed once and reused across every repo. This is how Moderne wins at scale and why per-repo LLM diffs do not.

### E. Verification (the trust)
- Recorded shapes become replay fixtures: synthetic values filled into the real schema. Generate a contract test per affected call site that FAILS on the new shape before the fix and PASSES after.
- Where the provider has a sandbox (Stripe, QBO, Shopify, GitHub), run the patched code live.
- The PR body: severity, blast radius (N call sites, M repos), the failing-then-passing test, and the observed evidence (first seen at timestamp, seen by K tenants).

### F. Advisory database (the standard)
- An open, machine-readable "API change advisory" format and public DB, modeled on GitHub's GHSA for security. Each advisory: provider, endpoint, change class, first-observed, published-notice (if any), codemod recipe.
- Seeded from the observed-contract network and the drift observatory below. Open data drives adoption and makes SHAPI the place providers publish to.

### G. Provider console (the distribution)
- Free for providers: "this change you plan affects 340 call sites across 57 customers; here are the three dominant code patterns." Nobody can give them this today.
- Providers push verified PRs to opted-in customers through SHAPI. That is the per-provider branch of the RFS, delivered by the neutral party.

### H. MCP / agent gateway (the second wedge)
- Same engine applied to MCP tool schemas and agent tool calls. Agents are the fastest-growing API consumer and have no human noticing failures. The shape extractor as an MCP gateway is a natural second product.

## 4. Unique research to run (and publish)

1. API Drift Observatory: probe the public endpoints of the top 200 APIs daily, diff against their published specs, publish spec-vs-reality drift scores. Like SSL Labs for API contracts. Press, inbound, and advisory DB seed in one.
2. GitHub commit mining: search public repos for commits fixing third-party API breakage ("fix stripe api version", "update to graph v20", "handle 200 from workflow_dispatch"). Measure frequency per provider and time from provider change to fix commit. This produces the missing "hours lost" number from real data, not a survey.
3. 15-20 interviews with teams running 10+ integrations, scripted around their last incident.

## 5. The claim to make in the application

"We knew GitHub changed workflow_dispatch from 204 to 200 eleven minutes after it shipped, before GitHub's changelog, because four customers' traffic saw it. Every affected repo had a PR within the hour, each with a contract test that failed before the fix and passes after."

Build the demo on that exact incident. It is public, verifiable, and no changelog tool could have caught it.

## 6. Risks and how to handle them

- Instrumentation friction: start with OTel exporter and client middleware, not a proxy. Shape-only, no payloads.
- Multi-language static analysis is deep: ship TypeScript and Python first.
- Provider terms of service on probing: observe own customers' traffic for the product; the observatory probes only public, unauthenticated endpoints.
- Substitutes: generic coding agents and GitHub Dependabot. Neither has observed traffic or a usage map. Say so plainly.
- Several W27 applicants on this RFS: differentiate on the sensor and the verification, not on the pitch.

## 7. Ten-day build plan before Nov 2

Days 1-3: OTel shape exporter (Node + Python), shape store, diff on the GitHub 204->200 case.
Days 4-6: usage extractor for TypeScript via ast-grep, `api.lock` output, impact intersection.
Days 7-9: one codemod recipe (status-code set), generated contract test, GitHub App opening the PR.
Day 10: record the demo, start the GitHub commit-mining script in the background, write the application.
