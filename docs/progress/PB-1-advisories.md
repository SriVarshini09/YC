# PB-1 advisories: 7 → 54

What exists: 54 advisories in `advisories/` (bundled into `shapi-cli`, and the same set in the public `shapi-advisories` repository), plus 10 researched advisories in the public repo's `advisories/pending/` that SHAPI can't match precisely yet.
- **By provider:** Meta 11, Xero 7, HubSpot 5, Shopify 5, Twilio 4, Gemini 3, OpenAI 3, QuickBooks 3, Salesforce 3, X 3, Google 2, and 1 each for Anthropic, GitHub, Reddit, Slack and Stripe.
- **Status:** 49 verified, 5 unverified. An unverified one has its fact only on secondary sources, or no exact day from the provider. Its summary says what's missing.
- **25 deadlines between now and 2027-04-30**, for example Meta's 2026-10-27 removals, the Marketing API v24 sunset (2026-11-10), the OpenAI Evals API (2026-11-30), Salesforce SOAP `login()` controls (December 2026), Shopify's non-expiring tokens (2027-01-01) and Admin API 2026-01 (2027-01-16).

How they were made: five researchers, one per provider group, each read every date on the provider's own changelog, deprecation page or docs (or two independent sources). Then I re-opened sources for a sample (Anthropic API version 2026-10-21, OpenAI deprecations, Shopify versioning, the Meta Marketing API changelog, Meta's deprecated Insights metrics), and every date matched. Each file passes the public repo's validator and SHAPI's own loader.

Precision over count: an advisory that would flag calls that aren't affected went to `pending/` instead:
- model retirements on shared endpoints (OpenAI, Anthropic), which need the `model` value from the request body;
- Stripe `payment_method_types`, and HubSpot help-desk comments and lead status, which need body parameters;
- QuickBooks `ORDERBY Id`, which needs the `query` statement;
- the Salesforce standard-volume platform events and the QuickBooks Builder-tier quota.

Matcher changes in this repo:
- **Query triggers take `values`** (`{"name": "metric", "values": ["page_impressions"]}`), and a comma-separated value such as `metric=a,page_fans` matches when any item does. SHAPI already recorded query values, so the two Meta Insights advisories now flag only calls that request a removed metric. An older SHAPI ignores `values` and matches more broadly, so nothing breaks.
- The Salesforce SOAP `login()` advisories use the `hosts` field (`login.salesforce.com`, `test.salesforce.com`), so other SOAP calls don't match.
- Shopify's provider entry includes `discover.shopifyapps.com` (Global Catalog API).
- The advisory sync test counts the bundled advisories instead of expecting 7, and checks that `pending/` is not synced.

Verified: 227 tests pass, plus lint and typecheck. The demo (`fixtures/demo-ts`) shows 3 affected call sites with the full set, the same three as before.
