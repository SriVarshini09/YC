# SHAPI: YC Winter 2027 application draft

Draft for the founders to edit. Deadline: November 2, 2026, 8pm PT. Everything below is true as of 2026-10-22 and points at things that exist. Research numbers come from `research/04-commit-mining.md` and `research/05-observatory.md`. `⟦FILL: …⟧` marks what only the founders can write.

## Company

**Company name:** SHAPI

**Describe what your company does in 50 characters or less.**
Fix PRs for code that third-party APIs break *(45 characters)*

**Company URL:** ⟦FILL: domain, or the public repo once it is public⟧

**Demo video:** ⟦FILL: link once recorded. Script in research/07-demo-script.md⟧

**Link to the product:** ⟦FILL: npm package link once `shapi` is published⟧. Live example of the output: https://github.com/SriVarshini09/shapi-demo/pull/2

**What is your company going to make?**

SHAPI keeps a codebase working when the APIs it depends on change. It's the "Dependabot for API behavior" from the Self-Maintaining APIs RFS, built on one difference: every tool today works from what the provider *says* (changelogs, OpenAPI specs, SDK versions), while SHAPI works from what the API actually *does* and what your code actually depends on.

1. **Scan (60 seconds, nothing installed).** `npx shapi scan` maps every third-party API call site in a repo into an `api.lock`: provider, endpoint, file:line, and exactly what that code relies on (status codes it branches on, fields it reads, enum values it compares, version headers and query parameters it sends). It matches this against an open advisory database of breaking changes and tells you which call sites will break and why. "`src/deploy.ts:13` compares the response status to 204; GitHub now answers 200."
2. **Watch.** A canary fleet calls provider APIs on a schedule from SHAPI-owned accounts and records response *shapes* (types, value classes, status codes; never payload values). When a shape changes in a breaking way, SHAPI drafts an advisory before any changelog exists.
3. **Fix, verified.** For each affected call site, SHAPI generates a contract test from the provider's old and new responses, confirms it fails, applies a deterministic recipe (or asks Claude when no recipe fits), and keeps the change only if the test then passes. It opens the pull request with the fix, the test, and the evidence.
4. **Inside coding agents.** An MCP server and agent skill let Claude Code or Cursor run the whole loop from the editor.

The first incident we built on is real: in December 2025 GitHub's `workflow_dispatch` endpoint started answering `200` with a body instead of `204`. Its OpenAPI spec and docs still said 204, there was no changelog, and integrations that checked for exactly 204 broke in production. SHAPI's replay of that change produces the breaking-change advisory automatically. `shapi fix` then opens a one-line fix plus a contract test, and CI goes green: https://github.com/SriVarshini09/shapi-demo/pull/2

**Where do you live now, and where would the company be based after YC?** ⟦FILL⟧

## Progress

**How far along are you?**

Working end to end; it's all in the repo, with 122 automated tests:

- **Scan:** TypeScript/JavaScript call-site extraction (fetch, axios, got, undici, ky, and SDK clients such as Octokit and Stripe) with per-call-site dependency surfaces, a deterministic `api.lock`, and an open advisory format with 7 researched advisories (GitHub, QuickBooks, Xero, Reddit, Meta Graph ×2, HubSpot).
- **Watch:** live canaries on GitHub (including the `workflow_dispatch` endpoint, against our own test repo) and Stripe test mode; shape inference, a shape store, a breaking-change classifier, and machine-drafted advisories with evidence.
- **Fix:** the status-code recipe, generated contract tests, a sandboxed test-first repair agent with a Claude fallback (verified live on a case the recipe can't fix), and GitHub PR delivery.
- **Agents:** an MCP server and agent skill, verified in a real Claude Code session.

**Research we ran to check the thesis:**

- **Drift observatory** (research/05-observatory.md). We called the public endpoints of 50 APIs that publish official OpenAPI specs. 70% contradicted their own spec on at least one endpoint, and only 24% of endpoints fully matched. 18% of the providers we tried publish a spec for a host that no longer exists. Spec diffing inherits this error; SHAPI watches responses.
- **Commit mining** (research/04-commit-mining.md). We searched public GitHub commits for fixes to five provider changes and verified them by hand.
  - **GitHub's silent 204→200 change:** 3 repos fixed it the same day. The other verified fixes for code that rejected the new 200 landed a median 203 days later, up to 300. Another 21 repos broke again when GitHub partly reverted the change.
  - **QuickBooks' silent minor-version change:** teams moved to the new version a median 343 days after Intuit started ignoring the old one, and one team pinned the ignored version eleven months in.
  - **Reddit, Meta Graph and Xero:** the same long tail across hundreds more repos.

**How long have each of you been working on this? How much of that has been full-time?** ⟦FILL⟧

**What tech stack are you using?**

TypeScript on Node 22+, a pnpm monorepo: ts-morph for static analysis, zod schemas, SQLite (better-sqlite3) for the shape store, vitest for generated contract tests, Octokit for PR delivery, and the MCP TypeScript SDK. The repair agent calls Claude (claude-fable-5-1) only when no deterministic recipe fixes a call site, and its output is kept only if the generated test passes. We build with Claude Code.

**Are people using your product?** ⟦FILL: honest answer; if none yet, say so and say who you are talking to⟧

**Do you have revenue?** ⟦FILL⟧

## Idea

**Why did you pick this idea to work on? Do you have domain expertise? How do you know people need it?**

⟦FILL: the founder's own story (an integration you maintained that broke, and how long it took to notice and fix)⟧

The evidence beyond us:

- **Undocumented changes break production.** GitHub's 204→200 change shipped without a changelog or a spec update and broke Terrateam in production. Since August 2025 QuickBooks has silently answered old minor versions as version 75. Reddit's logged-out `.json` endpoints started returning 403 overnight in May 2026.
- **Deadlines pile up.** Public trackers list 192 upcoming API, model and SDK deadlines across 37 vendors (Harbyn, October 2026). Blotato counted 34 breaking changes across 10 social platforms in two years; of the 20 it could date, 5 came with a week's notice or less.
- **Specs can't be trusted to detect it.** Our observatory found 70% of APIs disagreeing with their own published spec.
- **Fixes are slow.** In public repos, fixes for GitHub's silent change landed a median 203 days after it, and fixes for QuickBooks' a median 343 days after. That is months of code quietly doing the wrong thing, and exactly the window SHAPI's canaries and matcher close.

**Who are your competitors? What do you understand that they don't?**

| Approach | Examples | Why it misses |
|---|---|---|
| Changelog monitors | APIDrift, DeprecationWatch | Read announcements. The changes that hurt most have no announcement. |
| Spec diffing | oasdiff, Bump.sh, Speakeasy | Trust the spec, which our observatory shows is usually wrong about the live API. |
| Unified APIs | Merge, Nango, Apideck | Maintain their own adapter, never your code, and lock you into their schema. |
| Runtime self-healers | Superglue, Refold | Change behavior in the data path with an LLM at runtime. A "healed" semantic change can return wrong data with a 200. |
| Dependabot plus coding agents | — | Trigger on package versions. API behavior changes without an SDK bump, and teams' tests mock the provider, so nothing fails. |

What we understand: the ground truth is the contract each call site actually depends on, set against what the API actually returns. So SHAPI is deterministic where it matters. Recipes do the fixing, a generated test is the gate, and the LLM handles only the residue, boxed in by both. That's why its PRs can be merged without a long review.

**How do or will you make money? How much could you make?**

⟦FILL: founders to decide. Proposal:⟧ The scan and the public advisory database are free (that's the growth loop). Teams pay for the GitHub App that watches their repos and opens verified fix PRs, priced per repository or per integration. Larger customers pay for traffic-based detection (an OpenTelemetry exporter sending shapes, never payloads) and private advisories. Later, providers pay to see which customers a planned change will break and to push verified PRs to them.

Market sizing: a mid-market SaaS company spends an estimated $50K–$200K a year on third-party API incidents, and a single emergency migration costs $5K–$150K (techconcepts.org estimates, not a survey). Detection alone sells for $10–20 a month. Verified fixes replace engineering time, which is where the money is.

**Category:** Developer tools

**Other ideas you considered:** ⟦FILL⟧

## Founders

⟦FILL for each founder: name, role, background, the most impressive thing you've built, how long you've known each other, who writes code⟧

## Claims to keep straight

- Say "SHAPI's replay of the GitHub change produced the advisory automatically", not "we caught it live". It happened before we built SHAPI.
- Say "70% of the 50 APIs in our sample". The sample skews toward small and public-data APIs; the observatory doc says so.
- Fix-lag medians come from small hand-verified sets of public repos (9 GitHub "accept 200" fixes, 12 QuickBooks fixes). Say "in public repos" and cite the counts if asked.
- Customers, revenue and the detection-latency claims in research/02 ("four customers' traffic saw it") are future-tense until they're true.
