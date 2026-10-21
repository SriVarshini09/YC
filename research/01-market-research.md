# SHAPI market research: Self-Maintaining APIs (YC RFS Fall 2026)

Compiled 2026-10-21. Application deadline for YC Winter 2027: November 2, 2026, 8pm PT.

## 1. The RFS in one paragraph

YC's Fall 2026 Request for Startups includes "Self-Maintaining APIs" by Harsha Gaddipati. His claim: "API communication is broken." Providers ship breaking changes with short notice, bury features in changelogs nobody reads, and customers find out when things stop working. Why now: coding agents made it normal to give outside tools write access to a codebase. Ask: a "Dependabot for API behavior" that connects a repo and the providers it uses, tracks changes, finds affected code paths, opens fix PRs, and lets the customer review and merge. Two shapes: per-provider agents, or a neutral cross-vendor service.

## 2. Public evidence that the pain is real

### Named incidents (last 12 months)

| Date | Provider | What happened | Who got hurt | Source |
|---|---|---|---|---|
| Dec 19, 2025 | GitHub | workflow_dispatch changed 204 -> 200 + body; OpenAPI schema and docs still said 204; no version, no changelog | Terrateam (Stategraph) broke in production | stategraph.com/blog/github-broke-the-contract |
| 2025 | GitHub | PR behavior changed with no change to URL, payload, or headers | Mergify, escalated to GitHub support | blog.mergify.com |
| Aug 1, 2025 onward | QuickBooks Online | Minor versions below 75 silently ignored, answers as v75 with no error; strict parsers fail silently | Every QBO integration | apideck.com blog, Oct 16 2026 |
| Sep 1, 2026 | Intuit | OAuth outage 13:00-20:45 PT; invalid_grant looks identical to customer revocation; one dev saw every call fail for 18 days | QBO integrators | apideck.com |
| Jun 30, 2026 | Xero | New organisation class enum crashed the official .NET SDK | Xero integrators | apideck.com |
| May 30, 2026 | Reddit | Logged-out .json endpoints started returning 403 overnight | "took out half my product overnight" (Om Patel on X); Claude MCP servers broke | x.com/om_patel5, aiweekly.co |
| Jun 2026 | X | API "breaking silently with no warning" | Reply to @levelsio | x.com/trifon_getsov |
| 2024-2026 | X | Media upload handler disabled without warning, docs not updated; "paying for a broken API for four months" | X dev forum | devcommunity.x.com |
| 2018 | Cheddar | TLS 1.0 dropped, customer "found out the hard way"; vendor apologized for no notice | Cheddar customers | support.getcheddar.com |
| 2026 | Upstox | Docs-only deprecation notices; customer demanded release notes and emails; vendor admitted no formal process | Upstox API users | community.upstox.com |

### Aggregate data

- Blotato Social Media API Report 2026: 130 changes across 10 platforms (Oct 2024 to Sep 2026), 34 breaking. Of 20 dated breaking changes, median notice 90.5 days but 5 gave a week or less; X median 4.5 days, two effective same day. Three Pinterest changes announced after the fact. LinkedIn retired 25 API versions; Facebook retired 6.
- Harbyn deadline tracker (Oct 13, 2026): 192 upcoming API, model, and SDK deadlines across 37 vendors.
- Truto (citing a ResearchGate study, not verified): 14.78% of API changes break backward compatibility. Rule of thumb: ~15 of every 100 vendor changes per quarter break an integration.
- Truto incident logs, ranked causes of post-deploy integration failure: (1) OAuth token expiry/silent revocation, (2) undocumented breaking changes, (3) rate limits/quota, (4) silent webhook drops and payload mutations, (5) semantic drift with unchanged schema, (6) environment mismatches.
- techconcepts.org (estimates, not survey): emergency migrations $5K-$150K+; mid-market SaaS spends $50K-$200K/yr on third-party API incidents.
- CMU/HKUST paper (arXiv 2311.11123): LLM providers update APIs silently and deprecate models, causing measurable performance regressions and prompt rewrites.
- Postman State of the API 2025 (5,700+ respondents): 51% of orgs have deployed AI agents; only ~25% design APIs for agents. Nothing on breaking changes or maintenance time.
- Dev.to post claims 67% of devs hit unexpected breaking changes and 89% have inadequate monitoring. No source named. Do not cite.

### What we could NOT get

- Reddit threads directly (reddit.com blocks our crawler). Reddit-origin complaints came via secondary quotes only.
- A rigorous survey of engineering hours lost to third-party API breakage. This gap is itself an opportunity: 20 customer interviews would produce the first real number.

## 3. Competitive landscape

### Layer A: change detection and alerting (CROWDED, low price points)

| Tool | What it does | Price | Notes |
|---|---|---|---|
| APIDrift | Scrapes 26+ changelogs daily, Gemini classifies, AI migration guides | $10-30/mo | No spec diff, no live probing, no traction shown |
| DeprecationWatch | Monitors docs/changelogs/forums for 500+ APIs, alerts | $20/mo | Self-reported 10K users, unverified |
| ApiNotes, changes.watch, sitegauge, harbyn, deprecatr, apiscout | Changelog/docs monitoring, deadline calendars | free to ~$20/mo | Indie-scale, interchangeable |

Verdict: detection alone is a $10/month feature, not a company.

### Layer B: provider-side spec diffing (MATURE)

Bump.sh, Optic, oasdiff, Speakeasy change detection. Diff your own OpenAPI spec in CI, flag breaking changes before shipping. Only works when a spec exists and is accurate. Does nothing on the consumer side.

### Layer C: unified APIs / embedded iPaaS (WELL FUNDED, adjacent)

Merge ($75M raised, 2,500+ customers in 2022), Nango (YC, 900+ APIs), Apideck, Paragon (YC), Truto, Knit. They absorb maintenance for the categories they cover (HR, CRM, accounting, ticketing). Weakness: only their normalized schema, lock-in, pricing that scales badly, and customers (Unthread, Index) leave when fields are missing. They do not touch your own code.

### Layer D: runtime self-healing (EARLY, YC-adjacent)

- Superglue: YC W25, ~$500K pre-seed, open source, regenerates integration code when the API drifts.
- Pomerado: turns legacy portals/sites into deterministic API/MCP endpoints, patches broken steps.
- Refold: enterprise SAP/Oracle/Workday mapping repair with audit trail.
- AutoHeal.ai: hackathon proxy that proposes patches.
- Incumbents (Boomi, Kong, Workato, MuleSoft) market "agentic self-healing."

These heal a runtime adapter they own. None opens PRs in your repo.

### Layer E: generic code-change automation (BIG, not API-aware)

- GitHub: Dependabot alerts assignable to Copilot/Claude/Codex agents (Apr 2026 changelog) to open draft fix PRs. Package-level only. Earlier "Copilot Autofix for Dependabot" preview appears abandoned.
- Sourcegraph Agentic Batch Changes, Moderne/OpenRewrite, Amazon Q Transformation: large-scale migrations, framework-level.
- Risk: GitHub adding "API deprecation alerts" on top of agent assignment is one plausible move.

### Layer F: per-provider agent skills (FORMING)

Stripe ships an "upgrade-stripe" agent skill; Cloudflare, Supabase, Vercel ship official skills for coding agents; 1,400+ skills indexed. This is the "per-provider" branch of the RFS, done by the top ~20 vendors for themselves. The long tail of vendors will not.

### Layer G: the real substitute

A developer pastes the changelog into Claude Code or Cursor and says "fix it." Any product here must do what that cannot: know the change happened, know it affects this repo, and prove the fix works against the live API.

## 4. Where the gap is

Nobody closes the loop: change detected -> affected code paths in MY repos found -> fix PR generated -> fix verified against the real API or sandbox -> merged. Specifically missing:

1. Impact analysis that maps a provider change to actual call sites across many repos (not just "Stripe changed something").
2. Verification: running the patched code against the provider sandbox or recorded traffic so the PR is trustworthy.
3. Long-tail coverage: vendors with no OpenAPI spec, where detection needs docs scraping, SDK commit mining, and live-response diffing.
4. Silent behavior changes with unchanged schemas (QBO minor-version fallback, GitHub 204->200, Meta version fall-forward). Changelog scrapers miss these entirely.
5. Provider-side distribution: a vendor ships a change and pushes verified PRs to every opted-in customer.

## 5. Is the space crowded?

- Detection: yes, by indie tools at $10-20/month. Do not compete here.
- Runtime healing and unified APIs: funded, but they solve "we own the integration" not "fix your code."
- The PR-shaped, consumer-side, verified-fix loop the RFS describes: nobody found as of Oct 21, 2026. Expect several YC W27 applicants on this exact RFS, so differentiation must come from verification and impact analysis, not from the pitch.
- Biggest threats are substitutes, not competitors: generic coding agents, GitHub extending Dependabot, and top providers shipping their own skills.

## 6. Recommended problem statement (draft)

"Engineering teams with 10+ third-party integrations find out an API changed when customers complain, then spend days scrambling. SHAPI watches every API your repos call, tells you which call sites break, and opens a PR that has already passed against the provider's sandbox."

Beachhead candidates:

- B2B SaaS with many SaaS integrations (accounting, CRM, HR): strongest incident evidence (QBO, Xero, HubSpot, Salesforce quirks).
- AI startups on LLM provider APIs: highest churn (192 deadlines), fixes need evals not just code, buyers are concentrated in YC itself. Risk of drifting into eval tooling (Braintrust, LangSmith).
- Social/marketing tools on platform APIs (X, Meta, LinkedIn, Reddit): shortest notice periods, highest breakage rate.

## 7. Next steps before Nov 2

1. 15-20 interviews with CTOs/platform leads at companies with 10+ integrations. Ask: last time an API broke you, how you found out, hours lost, what you pay today.
2. Build a demo on one real incident (e.g. GitHub 204->200 or QBO minor version) showing detect -> impact -> verified PR.
3. Decide beachhead from interview data, not from this doc.

## Sources

- https://www.ycombinator.com/rfs
- https://www.ycombinator.com/apply
- https://x.com/ycombinator/status/2079963746764808559
- https://modelence.com/yc-rfs-fall-2026/self-maintaining-apis
- https://stategraph.com/blog/github-broke-the-contract
- https://blog.mergify.com/handling-unexpected-third-part-change
- https://www.apideck.com/blog/ai-built-accounting-integrations-maintenance
- https://truto.one/blog/one-page-quick-reference-6-causes-of-saas-integration-failures-post-deployment/
- https://truto.one/blog/a-detailed-incident-runbook-for-handling-api-breaking-changes-across-multiple-saas-integrations/
- https://www.blotato.com/research/social-media-api-report
- https://harbyn.com/deadlines
- https://www.deprecatrai.com/providers/
- https://x.com/om_patel5/status/2112211234820956315
- https://x.com/trifon_getsov/status/2065029864575455292
- https://devcommunity.x.com/t/why-did-you-break-the-media-upload-api/243552
- https://devcommunity.x.com/t/i-have-been-paying-for-a-broken-api-for-four-months/219998
- https://aiweekly.co/node/2176
- https://community.upstox.com/t/release-notes-breaking-changes-introduced-randomly/2935
- https://support.getcheddar.com/discussions/problems/9782-notice-of-api-updates
- https://techconcepts.org/blog/third-party-api-dependency-risks
- https://arxiv.org/pdf/2311.11123v2
- https://www.businesswire.com/news/home/20251008162423/en/
- https://dev.to/mrdubey/breaking-changes-why-your-api-monitoring-is-failing-you-and-how-we-fixed-it-2ib9
- https://apidrift.dev/
- https://www.deprecationwatch.com/
- https://apinotes.io/
- https://bump.sh/api-change-management
- https://www.speakeasy.com/blog/api-change-detection-open-enums
- https://merge.dev/blog/announcing-merges-55-million-series-b
- https://nango.dev/nango-vs-merge
- https://www.vcbacked.co/company/superglue
- https://pitchbook.com/profiles/company/761476-69
- https://aitoolly.com/product/pomerado
- https://www.refold.ai/
- https://github.blog/changelog/2026-04-07-dependabot-alerts-are-now-assignable-to-ai-agents-for-remediation
- https://github.com/orgs/community/discussions/141502
- https://sourcegraph.com/solutions/code-migrations-and-modernization
- https://moderne.io/white-papers/moderne-platform-technical-overview
- https://docs.stripe.com/.well-known/skills/upgrade-stripe/SKILL.md
- https://supabase.com/docs/guides/ai-tools/ai-skills.md
- https://flaviocopes.com/cloud-platform-plugins-ai-coding-agents.md
- https://github.com/tripathyjayesh/API-Dependabot
