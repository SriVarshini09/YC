# PB-11 scanner detection gap

## The gap
`shapi scan` found none of the outreach leads' affected call sites. The "Scanned: missed" rows in `docs/gtm/shapi-first-10-customers.xlsx` had code like Estuary's `f"{HUB}/crm-pipelines/v1/..."`, Pipeboard's `META_GRAPH_API_VERSION = "v24.0"` and Colossal's `"https://{{config.shopDomain}}/admin/api/2026-01"`. I took the one file per lead that holds the call and scanned it with the local CLI:

| Lead | Before | After |
|---|---|---|
| Estuary (Python) | no call site | affected: HubSpot Pipelines v1 |
| Optiply (Python, Singer) | URL unresolved | affected: HubSpot Pipelines v1 |
| Cien (Python, Airbyte CDK) | URL unresolved | affected: HubSpot Pipelines v1 |
| Meltano (Python, Singer) | no call site | affected: HubSpot Pipelines v1 |
| Colossal (TypeScript) | no call site | affected: Shopify Admin API 2026-01 (2 call sites) |
| Pipeboard (Python) | URLs unresolved | possibly affected: Meta Marketing API v24.0 (4 call sites) |
| DeepVisor (TypeScript) | no call site | possibly affected: Meta Marketing API v24.0 |
| Bin-Huang (TypeScript) | URL unresolved | possibly affected: Meta Marketing API v24.0 |
| Jitsu (TypeScript) | no call site | possibly affected: Meta Marketing API v24.0 |

## What changed
- **URLs outside recognized clients** (`looseUrlSites` in `callsites.ts`, `looseUrls` in `python.ts`):
  - A URL of a known API is a call site with an unknown method, even when no recognized client sends it. That covers a project's own helper (`apiRequest.call`, `ctx.fetch`, Estuary's `http.request`), a config object (`baseUrl: "https://..."`), and a framework's `url_base` / `path` / `url`.
  - **Not counted:**
    - a URL a recognized call in the file already covers;
    - a base that another URL in the file extends;
    - error messages, docstrings and import specifiers.
- **Paths that name their provider** (`providerForPath` in core):
  - `/admin/api/YYYY-MM/...` is Shopify on any shop domain.
  - `/crm-pipelines/v…` is HubSpot.
  - This is used when the host is built at runtime (`https://${shop}/...`, `{{config.shopDomain}}`) or comes from another file (`{HUB}/crm-pipelines/...`).
- **TypeScript:**
  - `url.toString()`, `String(url)` and `url.href` evaluate to the URL.
  - When functions in a file reuse a const name (`const api = ...` in each), a use resolves to the const of its own block. Before, the last one in the file won, so Slack URLs in `canary/src/workers/more.ts` read as HubSpot.
- **Python:** inside a function, a name resolves to its last assignment before the use (`url = f"{META_GRAPH_API_BASE}/{endpoint}"`), as well as to module constants.
- **Possibly affected** (`matchAdvisories(...).possible`):
  - **What it covers:** a call whose path is only partly known, where the change is narrower than the call. `/v24.0/{endpoint}` is affected by Meta's v24.0 Marketing API sunset only if `endpoint` is an ad account (`act_...`).
  - **Evidence required:** a literal segment of the advisory's pattern (here `v24.0`) has to be in the known part of the path. So `/v24.0/{path}` doesn't become "possibly affected" by `/*/*/commerce_orders`.
  - **In the CLI:** it lists them under "Possibly affected, check these", and in JSON under `possible`. They never fail a build.
  - **Not yet:** the GitHub App's checks and the web app don't show them yet.
- **Docs:** `site/guide/how-it-works.md` and `site/guide/quickstart.md` describe the new call sites and the possibly-affected list.

## Not covered yet
- **Base URLs from other files:** these only resolve when the path names its provider (the HubSpot and Shopify signatures). A general `from .shared import HUB` or `import { BASE } from "./config"` is not followed.
- **Path-only strings** for other providers, such as n8n's `const endpoint = '/crm-pipelines/v1/pipelines/deals'`: this one is caught by the HubSpot signature, but no other providers have signatures.
- **Other languages:** PHP, YAML manifests (Airbyte's declarative connectors), Java and Ballerina are still not scanned.

Verified:
- **Static checks:** `pnpm typecheck` and `pnpm lint` are clean.
- **Tests:** `pnpm test` passes, 40 files and 281 tests. The new tests are `packages/extractor/test/loose-urls.test.ts` and "possibly affected" in `packages/core/test/matcher.test.ts`.
- **Demo project:** `shapi scan fixtures/demo-ts` is unchanged: 5 call sites, 3 affected, none possibly affected.
- **SHAPI's own code:** in `apps/server/src` and `packages/canary/src` every URL resolves to the right provider.
