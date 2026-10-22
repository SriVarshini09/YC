# Advisory Sources, Ingestion Automation, Advisory Format Design, and Competitor Teardown for SHAPI

Research date: 2026-10-22. Everything below comes from pages fetched or searched on that date unless marked otherwise. Items marked **[UNVERIFIED]** come from my background knowledge or from secondary sources I could not confirm against a primary page.

---

## 1. Provider sources of truth: which are structured enough to parse automatically?

### Takeaway
Provider sources fall into three tiers. Tier A is structured enough to parse directly with little or no LLM help: versioned calendars with fixed dates, tables with retirement date and replacement columns, flags like "Breaking", feeds with category labels, and model-list APIs with a `shutdown_date` field. Examples are Stripe, Shopify, Meta Graph, OpenAI, Anthropic and the GitHub changelog RSS. Tier B is OpenAPI spec repos that can be diffed with oasdiff. Tier C is free-form prose changelogs, such as Slack's, which need LLM extraction. Most of the top LLM and commerce providers now publish a Markdown (`.md`) version of their docs pages, which makes deterministic scraping much cheaper.

### Cited Findings

**Stripe (Tier A)**
- The changelog groups entries by dated API version with a codename. It shows Clover (2025-09-30 to 2026-02-25), Dahlia (2026-03-25 to 2026-08-26) and Endive (`2026-09-30.endive`, the latest stable on 2026-10-22). Each stable family has a `.preview` channel beside it — [Stripe changelog](https://docs.stripe.com/changelog)
- Each entry is a table row with these columns: Title (linking to a per-entry page with a `.md` variant), Affected Products, **"Breaking change?" (`Breaking` / `Non-breaking`)**, and Category (`api` or `stripejs`). This explicit breaking flag is the most machine-friendly I found among the major providers — [Stripe changelog](https://docs.stripe.com/changelog)
- Dated releases arrive about every 4–6 weeks, and new named families about every 6 months. I saw no RSS or Atom link in the content I fetched, but the page and each entry are served as Markdown — [Stripe changelog](https://docs.stripe.com/changelog)

**Shopify (Tier A, a calendar you can compute)**
- Versions are named `YYYY-MM` and released quarterly at 5pm UTC on the first day of the quarter. Each stable version is supported for at least 12 months, and consecutive versions overlap by at least 9 months — [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
- The current table: 2025-10 became unsupported on Oct 16, 2026. 2026-01 is stable until Jan 16, 2027, 2026-04 until Apr 16, 2027, and 2026-07 until Jul 16, 2027. 2026-10 is the latest stable, until Oct 16, 2027, and 2027-01 is the release candidate — [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
- "Fall-forward": a request to an inaccessible version is served by the oldest accessible stable version, and the `X-Shopify-API-Version` response header shows which version was actually used. Deprecations are communicated through Dev Dashboard alerts, GraphiQL warnings, the developer changelog, API reference updates and emergency developer contacts — [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
- **[UNVERIFIED]** I believe the Shopify developer changelog has an RSS feed and that the `X-Shopify-API-Deprecated-Reason` header exists. The versioning page I fetched mentions neither.

**Meta Graph API (Tier A, a version table)**
- The versions page lists version, release date and expiration date. v26.0 was released Jul 29, 2026 (expiration TBD). v25.0 was released Feb 18, 2026 and expires Jul 29, 2028. v24.0 was released Oct 8, 2025 and expires Feb 18, 2028. v23.0 expires Oct 8, 2027, v22.0 expires May 20, 2027, and v21.0 expires Jan 21, 2027 — [Meta Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions)
- Each version stays available for about 2.3–2.5 years. The **Marketing API has its own version table with shorter expirations**: for example, v24.0 expired Oct 6, 2026 in the Marketing API but expires Feb 18, 2028 in Graph. Marketing API "version auto-upgrade" was scheduled to ship Jul 29, 2026 — [Meta Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions)

**OpenAI (Tier A, a table plus an API field)**
- The deprecations page has "Upcoming" and "Past" sections, newest first. Most entries are tables with shutdown date, deprecated model or endpoint, and recommended replacement. Recent entries: on 2026-10-14, the GPT-4o, 4o-mini, 4.1 and 4.1-mini shutdown was set for Jan 14, 2027, with replacement `gpt-6-luna`. On 2026-10-01, the shutdown of `tts-1`/`tts-1-hd` was set for Jan 6, 2027. On 2026-08-26, the shutdown of `/v1/audio/translations` and the transcription models was set for Feb 26, 2027 — [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- Programmatic signal: `GET /v1/models` returns each model with an optional `shutdown_date` (`YYYY-MM-DD` or null). Any page is available as Markdown by appending `.md`, and an llms.txt index exists. The page mentions no RSS feed — [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- The old URL platform.openai.com/docs/deprecations now 301-redirects to developers.openai.com, so scrapers must follow redirects — [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)

**Anthropic (Tier A, a table)**
- The lifecycle has four states: Active, Legacy, Deprecated and Retired. Anthropic gives at least 60 days' notice before retiring a publicly released model. A "Model status" table has the columns API model name, Current state, Deprecated date and Tentative retirement date. Each deprecation announcement has its own dated table of retirement date, deprecated model and recommended replacement — [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- Example: `claude-sonnet-4-5-20250929` was deprecated Sep 30, 2026 and retires Nov 30, 2026, with replacement `claude-sonnet-5-5`. There is also a parameter-deprecation table: `temperature`, `top_p` and `top_k` were removed in API version `2026-10-21` and now return a 400 error — [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- Dates differ on partner platforms (Bedrock, Vertex), which set their own schedules, so one model needs separate advisories per platform. No feed is mentioned. The docs moved from docs.anthropic.com to platform.claude.com behind a 301 redirect — [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)

**GitHub (Tier A feed, Tier B spec)**
- `https://github.blog/changelog/feed/` is RSS 2.0. Each item has `title`, `link`, `pubDate`, `guid`, `content:encoded` and `category`, where the `domain` attribute is either `changelog-type` or `changelog-label`. The types seen are **Improvement, Release and Retired**. Deprecations use "Retired"; there is no "Deprecation" type. Example: "GitHub Copilot models deprecated on October 19, 2026" is tagged Retired — [GitHub changelog feed](https://github.blog/changelog/feed/)
- The REST API uses date-based versions. `2022-11-28` was the first and contained no breaking changes. GitHub lists what counts as breaking: removing an operation, removing or renaming a parameter or response field, adding a required parameter, and so on. Breaking changes ship only in new API versions — [GitHub REST breaking changes](https://docs.github.com/en/enterprise-server@3.15/rest/about-the-rest-api/breaking-changes)
- The `github/rest-api-description` repo holds the OpenAPI descriptions under the **MIT license** — [rest-api-description README mirror](https://webdrift.org.ntnu.no/cgit/index.cgi/rest-api-description/tree/README.md)

**Slack (Tier C)**
- The developer changelog at docs.slack.dev/changelog is prose entries with "Release:" headings, a date and tags such as "Release" and "Slack CLI". My fetch found no deprecation or breaking label and no RSS link — [Slack changelog](https://docs.slack.dev/changelog)

**Spec aggregators**
- The APIs.guru openapi-directory is **CC0-1.0** for author-contributed definitions. Definitions taken from public sources are used under "fair use". Definitions are automatically re-fetched from their `x-origin` source "at least weekly" and revalidated. The project says roughly 80% of definitions contain mistakes that it fixes. The repo has about 1.8k open issues — [APIs.guru openapi-directory](https://github.com/APIs-guru/openapi-directory)

**Not fetched in this pass:** HubSpot, Twilio, Salesforce release notes, the stripe/openapi repo license and the twilio-oai repo license (see Gaps).

### Inferences
- For about half of the top 100, an adapter per provider plus a deterministic parser would beat pure LLM extraction: Shopify's quarterly calendar, Meta's version table, the OpenAI and Anthropic tables, the Stripe "Breaking" flag and GitHub "Retired" items. The LLM can then be kept for the long tail of prose (Slack, HubSpot, Salesforce).
- Several top providers serve `.md` versions of pages (Stripe, OpenAI) or are already Markdown (Anthropic). That makes stable content hashing and diffing practical, so change detection can be "page diff, then classify the diff" rather than "re-classify the whole page".
- Shopify and Meta deadlines can be computed from the version calendar before any changelog entry exists. SHAPI could generate "version sunset" advisories ahead of time.
- A source's own deprecation status is itself an advisory: OpenAI and Anthropic both moved their docs domains, and Optic's repo was archived. SHAPI ingesters need redirect tracking and source-health alerts.

### Gaps
- No primary-source check of RSS feeds for Shopify, Stripe, Slack, HubSpot, Twilio or Salesforce. GitHub's feed was confirmed.
- No check of the licenses for stripe/openapi or twilio-oai. **[UNVERIFIED]** I believe both use MIT or Apache-2.0 style permissive licenses; check each LICENSE file.
- Terms of service for redistributing facts derived from provider changelogs were not checked. Facts such as dates and endpoint names are generally not copyrightable, but verbatim migration text may be. A legal review is needed before republishing changelog prose verbatim.
- Not checked: SDK release feeds (the npm registry API, PyPI JSON/RSS, the GitHub Releases Atom feeds at `/<owner>/<repo>/releases.atom`). **[UNVERIFIED]** These are standard and well known.

---

## 2. HTTP deprecation signals (RFC 8594 Sunset, RFC 9745 Deprecation): status and adoption

### Takeaway
Both headers are now IETF RFCs. RFC 9745 (Deprecation) is a Standards Track RFC published March 2025. RFC 8594 (Sunset) is Informational, from May 2019. I found no primary evidence that major providers emit them widely. They are a useful runtime signal for SHAPI's canary or proxy, but not a reliable source for coverage.

### Cited Findings
- RFC 9745, "The Deprecation HTTP Response Header Field", is Standards Track, published March 2025 by S. Dalal and E. Wilde. It tells consumers that a URI-identified resource will be or has been deprecated, and it defines a `deprecation` link relation that points to human-readable migration info — [RFC 9745](https://www.rfc-editor.org/rfc/rfc9745.html)
- RFC 8594 (Sunset) is Informational, from May 2019. It signals when a URI is likely to become unresponsive, which is the decommission stage. Deprecation marks the start of the deprecation period and Sunset marks the end of life, and both are often paired with a `Link` header to docs — [RFC 8594](https://datatracker.ietf.org/doc/rfc8594); [DEV: Deprecation and Sunset headers](https://dev.to/apikumo/sunset-your-api-endpoints-on-purpose-the-deprecation-and-sunset-headers-4bmh)
- An IETF individual draft, "draft-rmili-httpapi-deprecation-manifest", proposes a machine-readable deprecation manifest. I only saw it in a search result and did not read it — [IETF datatracker](https://datatracker.ietf.org/doc/draft-rmili-httpapi-deprecation-manifest/)
- Evidence on adoption is weak. The only GitHub reference I found was a secondary skill document claiming the GitHub REST Issues Search deprecation uses production deprecation headers. I found no Stripe evidence — [openskillindex](https://openskillindex.com/skills/intense-visions-harness-engineering-api-deprecation-strategy)

### Inferences
- SHAPI's canary and runtime layer should log any `Deprecation`, `Sunset`, `Link rel=deprecation` header and vendor-specific header it sees (for example `X-Shopify-API-Version` fall-forward mismatches). Each sighting should feed in as a "signal" that opens or corroborates an advisory. This is ground truth from real traffic.
- If the IETF deprecation-manifest draft progresses, it would be a natural format to ingest. Worth watching.

### Gaps
- I found no survey of how many of the top 100 APIs send Sunset or Deprecation headers. **[UNVERIFIED]** From background knowledge, GitHub has sent `Deprecation`/`Sunset` on some deprecated endpoints, and Shopify uses `X-Shopify-API-Deprecated-Reason`. A small probe script over SHAPI's canaries could measure this directly.

---

## 3. Existing deadline trackers and aggregators (Harbyn, Changes.Watch, deprecatr)

### Takeaway
Two small public aggregators already exist. Harbyn has about 187–192 dated deadlines from 37–39 vendors, with iCal and Markdown output but no JSON. Changes.Watch has a free, no-auth JSON catalog whose schema already includes npm package ranges and codemod commands. Neither publishes a license or uses OSV. SHAPI can differentiate with an openly licensed, OSV-style schema that ties each advisory to endpoints and to code-level recipes.

### Cited Findings
- **Harbyn**: "187 dated changes from 39 vendors", spanning Oct 2026 to Oct 2031 (counted 2026-10-22). Search snippets dated 2026-10-13 said 192 from 37 vendors. Vendors include Google Gemini, Twilio, Azure OpenAI, OpenAI, Shopify, Amazon SP-API, AWS Lambda, Atlassian, GitHub, Meta Graph/WhatsApp, LinkedIn Marketing, Google Ads, HubSpot, Zendesk and others — [Harbyn deadlines](https://harbyn.com/deadlines)
- Harbyn's fields per entry are deadline (sometimes month-only), vendor, change, "use instead", a details link and a source link to the vendor's announcement. Exports are an iCal subscription (`harbyn.com/calendar.ics`) and Markdown pages. No JSON, API or RSS is mentioned, and the page states no license or pricing — [Harbyn deadlines](https://harbyn.com/deadlines)
- Search snippets describe Harbyn per-change pages that offer a "repository scan" to check whether your code uses a vendor's packages or API hosts. The deadlines page itself did not mention it — [Harbyn Google Cloud vendor page](https://harbyn.com/vendors/google-cloud)
- **Changes.Watch**: a free JSON catalog at `GET /api/v1/deprecations/catalog.json`. It needs no auth, supports ETag and CDN caching, and returns 503 rather than an empty catalog on failure. It is refreshed daily plus on verified editorial updates — [Changes.Watch catalog](https://www.changes.watch/developers/deprecations-catalog)
- The Changes.Watch schema has top-level `schemaVersion` (1), `generatedAt`, `catalogVersion` (a SHA-256 of the content), `total`, `notices[]` and `aliases[]` (npm package-to-product mappings). Each notice has `id`, `product`, `title`, `announcementAt`, `summary`, `severity`, `tags`, `officialSourceUrl`, `component`, `effectiveOn`, `lifecycleStatus`, `replacement`, `migrationUrl`, `verifiedAt` and `packageTargets[]`. Each package target has `ecosystem`, `package`, `affectedRange`, `migrationStrategy` (upgrade/replace/remove/manual/unknown), `replacementVersion`, `codemodCommand` and `breakingChanges` — [Changes.Watch catalog](https://www.changes.watch/developers/deprecations-catalog)
- Changes.Watch states that fields not verified by a human stay null and that it "never invents these values from prose", a clear verified-only policy. It does not say how many notices it holds or what license applies — [Changes.Watch catalog](https://www.changes.watch/developers/deprecations-catalog)
- **deprecatr**: no search results, so I could not confirm it exists.
- **"Developer Deprecation Watch"** is an AI agent listing on you.com. I saw it in search results only — [you.com agent](https://for.you.com/agents/developer-deprecations)

### Inferences
- Changes.Watch's `packageTargets` plus `codemodCommand`, and its verified-only nulls, closely match SHAPI's "recipe" concept. It is the closest prior art for the data model and could be a seed or cross-reference source (`aliases` in OSV terms), subject to license.
- Harbyn is broader than SHAPI's 7 advisories on deadline coverage but has no endpoint patterns or code-level matching. SHAPI's edge is endpoint, parameter and code-pattern granularity, not deadline lists.
- Neither declares a data license. An explicit CC-BY-4.0 (like GHSA) or CC0 license would be a real differentiator for SHAPI with tool builders.

### Gaps
- Licensing and terms for Harbyn and Changes.Watch data. I did not read their ToS.
- Changes.Watch catalog size. The sample shows `total: 1`. Fetching the live JSON would give the real count.

---

## 4. Advisory format design: what to borrow from OSV and GHSA

### Takeaway
OSV 1.9.2 (Oct 13, 2026) already provides most of what SHAPI needs: `id`, `modified` and `withdrawn` for lifecycle; `aliases`, `upstream` and `related` for cross-referencing; and `affected[]` with ecosystem or GIT ranges plus `ecosystem_specific` and `database_specific` extension points. SHAPI's "provider + endpoint pattern + API version range" maps onto `affected.package` plus `ranges`, with a custom ECOSYSTEM ordering for dated API versions. Two GHSA patterns are worth copying: curated versus unreviewed status recorded as a field, and community PRs merged through staging branches.

### Cited Findings
- OSV schema is at version **1.9.2, dated October 13, 2026**. Only `id` and `modified` are required. Optional fields include `published`, `withdrawn`, `aliases`, `upstream`, `related`, `summary`, `details` (CommonMark), `severity[]`, `affected[]`, `references[]`, `credits[]` and `database_specific` — [OSV schema](https://ossf.github.io/osv-schema/)
- `affected[]` has `package` (`ecosystem`, `name`, optional `purl`; `*` matches every package), `ranges` and `versions`. Range types are SEMVER, ECOSYSTEM (which uses the ecosystem's own ordering) and GIT. Range events are `introduced`, `fixed`, `last_affected` and `limit`; `fixed` is preferred because `last_affected` can cause false negatives. Each affected entry also allows `ecosystem_specific` and `database_specific` — [OSV schema](https://ossf.github.io/osv-schema/)
- ID rules: IDs take the form `<DB>-<ENTRYID>` and should be **semantically neutral**, encoding no type, package or severity. They begin with a registered prefix (GHSA, CVE, PYSEC, ...). The `x_` prefix is for local databases that OSV.dev does not aggregate. New ecosystems are added by PR to the schema repo — [OSV schema](https://ossf.github.io/osv-schema/)
- `severity[]` types are limited to CVSS_V2, CVSS_V3, CVSS_V4 and Ubuntu, so non-security severity must go in `database_specific` or `ecosystem_specific`. Reference types include ADVISORY, FIX, REPORT and WEB. Credit types include FINDER and REMEDIATION_DEVELOPER — [OSV schema](https://ossf.github.io/osv-schema/)
- GHSA stores each advisory as a separate OSV file in the `advisories` directory. A `github_reviewed` flag and a `github_reviewed_at` timestamp record curator review, rather than separate folders — [github/advisory-database](https://github.com/github/advisory-database)
- GHSA contribution flow: users click "Suggest improvements" on github.com/advisories or open a PR on the file. GitHub creates a **staging branch per PR**. The Security Advisory Curation team reviews it, accepted changes merge to staging and then to the primary data source, and a separate process syncs main. Original publishers can be @mentioned — [github/advisory-database](https://github.com/github/advisory-database)
- GHSA is licensed **CC-BY 4.0**. Its ID format is `GHSA-xxxx-xxxx-xxxx` from the alphabet `23456789cfghjmpqrvwx`, which avoids ambiguous characters, with random segments and the regex `/GHSA(-[23456789cfghjmpqrvwx]{4}){3}/`. Community contributions are accepted only for 12 ecosystems — [github/advisory-database](https://github.com/github/advisory-database)

### Inferences (proposed SHAPI mapping)
- **ID**: a neutral random ID with its own prefix, for example `SHAPI-xxxx-xxxx-xxxx` using the GHSA alphabet. Use `x_shapi` only if OSV.dev aggregation is not wanted. Registering a prefix with OSV would make SHAPI advisories visible to OSV tooling. That is a distribution channel, though OSV is security-focused and may not accept non-vulnerability records.
- **affected.package**: ecosystem `SHAPI-API` (or `HTTP-API:<provider>`), name like `stripe` or `github-rest`. The endpoint pattern (`POST /v1/charges`), HTTP methods and field paths go in `ecosystem_specific`.
- **ranges**: type `ECOSYSTEM`, with SHAPI defining the ordering for the provider's version scheme. Dated versions like `2026-04`, `2025-09-30.clover` and Graph `v24.0` all sort lexically or numerically. `introduced` is the first version with the new behaviour and `fixed` is not used; alternatively `last_affected` is the last version accepting the old call. Add a second `affected[]` entry per SDK (npm/PyPI package with SEMVER ranges) so lockfile scanners match SDK versions too. Changes.Watch's `packageTargets` does the same thing.
- **Dates and severity**: announce, deprecation-effective and sunset dates; change class; trigger; and severity (OSV severity is CVSS-only) all go in `database_specific`. The `recipe` (codemod or patch) goes in `database_specific` plus a `references` entry of type FIX.
- **aliases**: cross-reference Harbyn and Changes.Watch IDs and the provider's own changelog entry IDs (for example the Stripe per-entry slug).
- **Review workflow**: copy GHSA. Canary-drafted and LLM-drafted advisories land with `reviewed: false`, and humans flip it. Community PRs go to the public repo with a staging branch per PR. Follow the Changes.Watch policy of never filling unverified fields from prose.
- **License**: CC-BY-4.0, matching GHSA, so that ecosystem tooling can redistribute with attribution.

### Gaps
- Whether OSV.dev would accept a non-security "API breaking change" ecosystem was not researched. Check the osv-schema repo's ecosystem-addition discussions.
- GHSA review SLAs and curator team size were not found.

---

## 5. LLM-assisted classification of changelog entries: examples and accuracy

### Takeaway
LLM classification of changelogs is already used in production by small tools. APIDrift uses Gemini 2.5 Flash with a keyword fallback, and DepWatch claims AI false-positive filtering. However, I found no published accuracy benchmark for classifying breaking changes from release notes. The academic consensus is to use the LLM to infer or propose, then verify with deterministic tools.

### Cited Findings
- APIDrift checks HTML changelogs, GitHub Releases, RSS/Atom and Markdown docs once a day. It classifies with **Gemini 2.5 Flash as the primary model, automatic fallback routing, and a keyword-based fallback classifier**, into 7 change types (breaking, deprecation, feature, bugfix, security, performance, informational) and 3 severities (critical, warning, info). It also generates migration guides with AI — [APIDrift](https://apidrift.dev/)
- DepWatch runs daily changelog scans and uses AI to detect deprecations and "filter false positives". It claims detection within 24 hours — [DepWatch](https://depwatchai.com/)
- A 2026 Kennesaw State master's thesis tested an LLM agent (PyCoReX) for breaking-change detection on **code commits, not release notes** across 12 LLMs. Chain-of-thought prompting raised its best F1 from 0.82 to 0.85, and it outperformed static analysis tools — [Kennesaw thesis](https://digitalcommons.kennesaw.edu/masterstheses/145)
- A 2026 systematic literature review on breaking changes says LLMs work best "not as direct detectors of breaking changes, but as contract inference engines whose output can be verified by existing tools" — [arXiv 2605.24397](https://arxiv.org/pdf/2605.24397)
- ReleaseEval, a benchmark of 94,987 release notes from 3,369 repos across nine LMs, scores release-note generation with BLEU and ROUGE, not breaking-change classification. Summaries from raw diffs scored lowest and missed important updates — [ReleaseEval arXiv 2511.02713](https://arxiv.org/pdf/2511.02713)
- A 2026 paper on LLM release intelligence admits it "has not conducted a controlled study" of the factual accuracy of LLM summaries against human baselines — [arXiv 2603.14619](https://arxiv.org/pdf/2603.14619)
- Silent-change risk: a DEV Community post (older, based on community reports) says Google often changes Gemini API behaviour without a matching changelog entry — [DEV Community](https://dev.to/clawgenesis/gemini-15-pro-also-drifts-heres-what-changed-in-our-production-prompts-3fid)
- Changelog pages themselves churn. Modelsheet's automated "source drift" bot opened many GitHub issues for the Google Gemini API changelog page changing between September and mid-October 2026 — [modelsheet issue #198](https://github.com/AatmanAJ/modelsheet/issues/198)

### Inferences
- SHAPI should publish its own precision and recall. No competitor does, so a public eval would stand out. SHAPI already has 7 hand-verified advisories plus mined commits with verified lags (commit cafa8e6). These are the start of a labelled gold set.
- Recommended pipeline: (1) deterministic adapters for Tier-A sources; (2) an LLM extracts candidate records only from the *diff* of a page, with strict JSON schema output, and every date, endpoint and version must be quoted verbatim from the source span; (3) a validator rejects fields whose quoted span does not appear in the source, enforcing the Changes.Watch-style "never invent from prose" rule; (4) cross-check against an OpenAPI spec diff (oasdiff) where specs exist; (5) human review before `reviewed: true`.
- Canary or runtime observation, such as FlareCanary-style response-schema drift, covers silent changes that never reach a changelog. No changelog-only competitor can catch those.

### Gaps
- No benchmark specifically on LLM classification of changelog or release-note entries into breaking, deprecation and other classes. This is an open gap SHAPI could fill.
- APIDrift's actual false-positive rate is not published.

---

## 6. Competitor and adjacent product teardown (as of Oct 2026)

### Takeaway
The market splits into four clusters: (a) consumer-side changelog alert tools (APIDrift, DepWatch, Harbyn, Changes.Watch, FlareCanary), which are cheap at $0–35 a month, early, and alert-only; (b) producer-side spec, diff and SDK tooling (oasdiff, Bump.sh, Speakeasy, Stainless, Fern, formerly Optic), which is consolidating through acquisitions (Anthropic bought Stainless, Postman bought Fern, Atlassian bought Optic, Postman bought Akita); (c) unified and embedded integration platforms (Merge, Apideck, Nango, Paragon, Superglue), which absorb maintenance by owning the integration; and (d) dependency and refactor bots (Dependabot, Renovate, Moderne), which handle package versions and code transforms but not API behaviour. I found no product that combines provider-change ingestion, code impact detection and fix PRs, which is the YC RFS gap.

### Cited Findings

**(a) Consumer-side change monitoring**
- **APIDrift**: monitors 26+ pre-configured APIs, SDKs and libraries (Stripe, Square, Twilio, SendGrid, OpenAI, Anthropic, Prisma, Supabase, Vercel, AWS SDK, GitHub Copilot API) across 7 categories, with daily checks and Gemini 2.5 Flash classification. Output is email digests on all plans, plus Slack, webhooks and an iCal deprecation calendar on paid plans. Pricing: Free (3 APIs, weekly digest), Pro **$10/mo** (20 APIs, migration guides) and Team **$30/mo** (unlimited). The FAQ instead lists $12 and $35, so the page contradicts itself. It appears to be a solo indie project credited to "tskulbru.dev", with no traction figures. It does not open fix PRs — [APIDrift](https://apidrift.dev/). An MCP connector listing exists on Glama — [Glama](https://glama.ai/mcp/connectors/com.edgethirteen.www/apidrift)
- **DepWatch** (beta): daily changelog scans with AI, email alerts and "Migration Reports" with code examples. It says "11 APIs monitored", but its list shows "+20 more", which conflicts. Named providers are OpenAI, Stripe, Shopify, AWS, GitHub, Cloudflare, Twilio, Vercel, Supabase, Google Cloud and Anthropic. Pricing: Free with 3 watches at $1 per report, Pro $10/mo with 11 watches, Max $29/mo for all APIs. No traction figures — [DepWatch](https://depwatchai.com/)
- **"DeprecationWatch"**: I found no product by that exact name. DepWatch, above, is the closest match.
- **Harbyn** and **Changes.Watch**: see section 3.
- **FlareCanary**: consumer-side monitoring of response-schema drift for REST APIs and MCP servers. It polls endpoints, compares against learned baselines or OpenAPI specs, and ranks severity. The free tier covers 5 endpoints. It catches changes that providers never announce — [DEV Community / FlareCanary](https://dev.to/flarecanary/how-to-detect-api-breaking-changes-before-they-hit-production-257p)
- **PageCrawl**: generic page-change monitoring that sends to webhooks and ticketing tools — [PageCrawl](https://pagecrawl.io/blog/api-monitoring-track-changes-alerts)

**(b) Producer-side spec, diff and SDK tooling**
- **Optic**: acquired by Atlassian in spring 2024 at Team '24 and folded into Compass — [Atlassian blog](https://www.atlassian.com/blog/announcements/optic-acquisition). The `opticdev/optic` repo was **archived Jan 12, 2026** and is read-only, with 1.5k stars — [GitHub opticdev/optic](https://github.com/opticdev/optic). A community thread says LintGPT is no longer publicly available. That claim is from a community member, not Atlassian — [Atlassian Community](https://community.atlassian.com/forums/Compass-questions/LintGPT/qaq-p/2912984)
- **Akita / Postman Live Insights**: Postman acquired Akita (announced July 2023) — [BusinessWire](https://www.businesswire.com/news/home/20230719991128/en/Postman-Acquires-Akita-Software-to-Help-Build-the-Future-of-API-Observability). Akita was **sunset March 14, 2025** in favour of Postman Insights — [Postman notice](https://www.postman.com/lp/akita-sunsetting/). The agent continues as the open-source Postman Insights Agent — [apis.io](https://apis.io/providers/akita-software/)
- **oasdiff**: Apache-2.0 CLI, GitHub Action and web tool for OpenAPI 3.0, 3.1 and 3.2 that detects **773 distinct changes**, each with an ID and severity. Breaking-change detection is free. "oasdiff Pro" adds an approval workflow, audit trail and PR comments; no public price was visible. About 1.4K stars and 17M+ downloads. Named users include MongoDB, Stripe, LEGO, IKEA, Spotify and Microsoft — [oasdiff.com](https://www.oasdiff.com/)
- **Bump.sh**: API docs plus an automatic changelog that flags breaking changes between spec versions. Basic is $50/mo. Pro is $250/mo on most trackers, but one September 2026 review says $120, so the figure is disputed — [PricingSaaS](https://pricingsaas.com/companies/bump); [frontdeskreview](https://frontdeskreview.com/software/api-documentation-tools/bump-sh/)
- **Stainless**: SDK generator for OpenAI, Google, Cloudflare and others. **Acquired by Anthropic, announced May 18, 2026**. The price was not disclosed; The Information reportedly said talks centred on more than $300M, so treat that as unconfirmed — [wwwhatsnew](https://wwwhatsnew.com/2026/05/19/anthropic-adquiere-stainless-sdk-startup-openai-google-cloudflare-2026/); [entrepreneurloop](https://entrepreneurloop.com/anthropic-stainless-acquisition-300m-developer-tools-deal/). Before that it raised a $25M Series A led by a16z — [Stainless blog](https://www.stainless.com/blog/stainless-series-a)
- **Fern**: **acquired by Postman, announced Jan 7, 2026**, terms undisclosed. Fern Docs and the SDK generator (9 languages) keep their brand and roadmap. Used by 200+ companies, including Square, Auth0, Adobe, Twilio and ElevenLabs — [BusinessWire](https://www.businesswire.com/news/home/20260107174767/en/Postman-Acquires-Fern-to-Help-Businesses-Deliver-World-Class-Developer-Experiences)
- **Speakeasy**: SDK, Terraform and API tooling. Its last confirmed round was a $15M Series A (Oct 2024) led by FPV, with GV and Quiet. No public pricing (G2 says it is not provided). No 2026 round found — [Finovate](https://finovate.com/api-platform-speakeasy-raises-15-million-in-series-a-funding); [G2](https://www.g2.com/products/speakeasy-speakeasy/pricing)

**(c) Unified and embedded integration platforms**
- **Merge**: $55M Series B (Oct 2022, Accel), $75M raised in total, ARR up 30x year on year at that time, 2,500–3,000+ customers (sources conflict). Sacra estimated about $20M revenue in 2023 and a $317M valuation. It launched Agent Handler and Gateway in 2025 and published a "2026 State of Product Integrations" report (Mar 2026). No 2026 funding found — [TechCrunch](https://techcrunch.com/2022/10/24/merge-raises-55m-series-b-for-its-unified-api/amp); [Sacra](https://sacra.com/c/merge/); [everydev](https://www.everydev.ai/developers/merge)
- **Apideck**: $7.5M Series A (Nov 2024, Airbridge Equity Partners). A unified API that does not store customer data, covering accounting, CRM, HRIS, e-commerce, ATS, issue tracking and file storage — [Apideck blog](https://apideck.com/blog/series-a-funding); [Vestbee](https://www.vestbee.com/blog/articles/apideck-raises-7-5-m-led-by-airbridge-equity-partners)
- **Nango** (YC): code-first integrations infrastructure. A seed round in Mar or Apr 2026, reported as $7.5M led by Gradient; sources conflict on amount and date. Claims 10,000+ engineering teams and billions of API requests a month, and was reportedly cash-flow-positive before the seed — [rywalker](https://rywalker.com/research/nango); [Caplight](https://www.caplight.com/company/nango)
- **Paragon**: an embedded iPaaS founded in 2019 in LA. No 2025–2026 funding data found — [CB Insights](https://www.cbinsights.com/company/merge-2/financials)
- **Superglue** (YC W25): an open-source (GPLv3 per a third-party review), self-hostable "AI-native integration platform" whose agents build, monitor and **repair** integrations from natural-language prompts. It has a hosted version at app.superglue.cloud and an agent plugin for Claude Code. It raised a $500K pre-seed from YC (Mar 2025) per VCBacked — [till-freitag blog](https://till-freitag.com/en/blog/superglue-ai-integration-platform); [VCBacked](https://www.vcbacked.co/company/superglue)

**(d) Dependency and refactor bots**
- **Moderne** (OpenRewrite): a $30M Series B on Feb 11, 2025, led by Acrew, with Morgan Stanley, Amex Ventures and TIAA. OpenRewrite recipes are built into Amazon Q, Broadcom App Advisor and GitHub Copilot — [Intel Capital](https://www.intelcapital.com/moderne-secures-30m-to-drive-billions-in-enterprise-code-modernization-savings-based-on-its-innovative-tech-used-by-aws-microsoft-and-broadcom-ai-assistants/)
- **Renovate / Mend**: Renovate Enterprise pricing from third-party trackers is "up to $250/developer/year" by quote. Vendr reports minimum commitments of $100K–$250K a year and bundled deals at $120–220 per developer per year. All aggregator figures, unverified with Mend — [Vendr](https://www.vendr.com/marketplace/mend); [toolradar](https://toolradar.com/tools/mend/pricing)
- **Dependabot**: still shipping. On 2026-10-20 the Dependabot alerts REST API began including dependency versions, and support for npm 12, pnpm 11/12 and Bun 1.4 was added. It handles package versions and security, not API behaviour — [GitHub changelog](https://github.blog/changelog/2026-10-20-dependabot-alerts-rest-api-now-includes-dependency-versions/); [GitHub changelog feed](https://github.blog/changelog/feed/)

### Inferences
- **Consolidation:** acquirers are buying producer-side API tooling (Stainless to Anthropic, Fern to Postman, Optic to Atlassian, Akita to Postman). Consumer-side "my third-party APIs changed" is still served only by indie tools priced at $10–35 a month with about 11–39 vendors and no fix automation. That is SHAPI's opening, and also a warning that pricing like APIDrift's anchors expectations low for alert-only products. SHAPI's paid value has to be the fix PR and impact analysis, not the alert.
- **Partnership angle:** SDK generators (Stainless, Fern, Speakeasy) produce precise per-version SDK diffs for their customers' APIs. A provider-side "publish advisories in SHAPI format" integration would match the YC RFS's provider-led framing, and Stainless now sits inside Anthropic.
- **Moat:** oasdiff (773 checks, Apache-2.0) is a commodity engine for spec diffs that SHAPI should embed rather than rebuild.
- **Unified-API vendors** are both potential customers (they maintain hundreds of integrations) and indirect competitors (customers who outsource integrations do not need SHAPI). Superglue's "self-repairing integrations" is the most direct philosophical overlap, but it targets integrations it builds itself, not arbitrary customer code.

### Gaps
- Current pricing for Speakeasy, Merge, Paragon, Nango, Superglue and oasdiff Pro was not found or not fetched.
- 2026 traction for APIDrift, DepWatch, Harbyn and Changes.Watch: none published.
- Paragon funding was not found. **[UNVERIFIED]** From background knowledge, Paragon raised a Series B around 2024; I did not confirm this.

---

## 7. New startups and YC Fall 2026 RFS "Self-Maintaining APIs"

### Takeaway
YC's Fall 2026 RFS explicitly asks for "Self-Maintaining APIs". The pitch is Dependabot for API behaviour: track provider changes, detect affected code, and open fix PRs. It was authored by Harsha Gaddipati. Searches found no funded company that clearly matches all three steps as of Oct 2026.

### Cited Findings
- YC's X post for "Self-Maintaining APIs" (@GaddipatiHarsha) says "APIs change constantly, but the way providers communicate those changes is still broken. Breaking updates go unnoticed..." It proposes that coding agents find affected code in customer codebases and open the fix as a pull request — [YC on X](https://x.com/ycombinator/status/2079963746764808559)
- The RFS loop, as summarised: connect repo and providers; track versions, changelogs and specs, either per provider or "as a neutral tool across many vendors"; map breaking changes to code paths; score severity; generate fix PRs with tests; group changes; offer rollback and per-change opt-out; show a dashboard with time-saved metrics. It is described as "Dependabot for API behavior" — [Modelence RFS summary](https://modelence.com/yc-rfs-fall-2026/self-maintaining-apis); official list at [YC RFS](https://www.ycombinator.com/rfs)
- The RFS author reportedly says they have "worked with over 50 API vendors, mostly early-stage startups", and that the missing piece is the application layer connecting API providers to customer codebases. This comes from a secondary summary — [bigideasdb](https://bigideasdb.com/yc-request-for-startups-2026)
- Secondary write-ups give the application deadline as Jul 27, 2026. One cites a founder claim that "over 30% of service downtime at AWS" came from unnoticed external API or package changes; this is **unverified** and not in YC's own materials — [search summary of RFS write-ups](https://miningwells.com/blog/yc-request-for-startups)
- Two searches ("Dependabot for APIs" startup 2026, and API breaking change agent fix PR 2026) found **no launched product** combining provider changelog ingestion with agent-authored fix PRs. The closest are APIDrift (alert only), oasdiff (producer-side PR gate) and a Claude skill that blocks deploys pending a migration plan — [oasdiff](https://www.oasdiff.com/); [skills.rest](https://skills.rest/skill/breaking-change-detector-dyai2025)
- YC P26 batch company **Superlog**, "Make software self-healing", is adjacent but different; I saw it only in a search result — [YC Superlog](https://www.ycombinator.com/companies/superlog/jobs)

### Inferences
- The RFS's "neutral tool across many vendors" option is exactly SHAPI's open advisory database plus scan and fix. The RFS's provider-led option suggests a second go-to-market: providers publish advisories in SHAPI format and SHAPI distributes the fix PRs.
- Because no clear incumbent turned up, the race is about coverage and fix quality. Expect Fall 2026 applicants and agent platforms such as Superglue to move here quickly.

### Gaps
- I could not enumerate companies that actually applied or were funded under this RFS in the Fall 2026 batch. Demo Day lists were not yet searchable or not found.
- I could not access YC's own RFS page text directly; the summaries are secondary.

---

## 8. Market sizing signals

### Takeaway
I found no credible independent figure for the size of the "unified API" or "API change management" market. The best numbers are an investor estimate of over $50B a year in US spend on maintaining external-facing APIs (Activant), and vendor-sourced figures putting integration upkeep at 15–25% of build cost a year and $0.5–2M a year for 20 in-house integrations. All of these should be treated as directional.

### Cited Findings
- Activant Capital estimates companies spend "more than $50 billion annually in the U.S. alone on maintaining external-facing APIs", with $10K–$100K+ to build each integration in-house. The methodology is not shown in the excerpt — [Activant Capital: Unified APIs](https://activantcapital.com/research/unified-apis)
- Truto, a unified-API vendor, puts annual upkeep for a custom integration at 15–25% of the initial build. It says in-house integrations cost upwards of $500K a year for 20 integrations, and models a 3-year total of $1.15M–$2.5M in-house versus $177K–$580K with a unified API — [Truto 2026 buyer's guide](https://truto.one/blog/the-2026-buyers-guide-to-multi-category-unified-apis/)
- Unified.to, also a vendor, cites $1–2M a fully loaded year for 20 in-house integrations. It cites Leen's estimate of about 460 engineering hours in year 1, 120 of them maintenance — [Unified.to](https://unified.to/blog/build_vs_buy_for_saas_integrations_why_a_unified_api_costs_less_to_maintain_than_building_in_house)
- Adoption proxies: Merge has 2,500–3,000+ customers (2022), Nango claims 10,000+ engineering teams, Fern has 200+ companies, and oasdiff has 17M+ downloads — [TechCrunch](https://techcrunch.com/2022/10/24/merge-raises-55m-series-b-for-its-unified-api/amp); [rywalker](https://rywalker.com/research/nango); [BusinessWire](https://www.businesswire.com/news/home/20260107174767/en/Postman-Acquires-Fern-to-Help-Businesses-Deliver-World-Class-Developer-Experiences); [oasdiff](https://www.oasdiff.com/)
- Acquisition prices as a value signal: Stainless was reportedly priced at over $300M, about 2x its $150M Series A valuation (unconfirmed) — [entrepreneurloop](https://entrepreneurloop.com/anthropic-stainless-acquisition-300m-developer-tools-deal/)
- Change velocity, which drives the need: Stripe ships dated releases every 4–6 weeks; Shopify ships a version every quarter, each with a 12-month life; Meta Graph has about 2 versions a year, each living about 2.3–2.5 years; Harbyn lists about 187 dated deadlines across 39 vendors in the next 5 years — [Stripe](https://docs.stripe.com/changelog); [Shopify](https://shopify.dev/docs/api/usage/versioning); [Meta](https://developers.facebook.com/docs/graph-api/changelog/versions); [Harbyn](https://harbyn.com/deadlines)

### Inferences
- A bottom-up TAM could be built as: companies with 10+ third-party integrations × integrations per company × the share of maintenance hours that are reactive breakage fixes (for example 120 of 460 hours in year 1) × engineer cost. SHAPI's own mined commit lags (commit cafa8e6) can supply a credible, non-vendor "reactive fix" data point.
- Harbyn's count of about 187 deadlines over 5 years across 39 vendors, roughly 37 a year, suggests the top 100 APIs produce hundreds of deadline-class advisories a year. Endpoint-level breaking changes, such as Stripe's "Breaking" rows, add many more. This sizes SHAPI's review workload. **Inference, not measured.**

### Gaps
- No independent survey (Postman State of the API, Gartner, Forrester) on the number of companies with many integrations or on spend for integration maintenance was found in this pass. Merge's "2026 State of Product Integrations" report (Mar 2026) likely has relevant numbers but was not fetched.
- No figure was found for the size of the unified API market.
