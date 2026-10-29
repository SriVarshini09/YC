# How SHAPI works

Third-party APIs change behavior without a new version number. GitHub's `workflow_dispatch` started answering `200` with a body instead of `204`. QuickBooks began answering every minor version below 75 as 75. HubSpot retires its v1 pipelines API on December 4, 2026. Code written against the old behavior keeps compiling and breaks at runtime. SHAPI finds that code before your users do.

## 1. Map: the api.lock

SHAPI parses your TypeScript and JavaScript with the TypeScript compiler (through ts-morph) and finds every call to a third-party API:

- **HTTP clients:** `fetch`, axios, got, undici, ky, node-fetch
- **official SDKs** of the providers it knows, for example `@octokit/rest`, `stripe` and `@hubspot/api-client`.

An axios, got or ky instance keeps its base URL, headers and default query for every call, also as a class member (`this.http.get(...)`). An SDK client constructed in one file and imported from another (`import { openai } from "./lib/openai"`) is followed to the file that constructs it. Dependencies and build output are not scanned: `node_modules`, `dist`, `build`, `public` and similar folders, and minified bundles (`*.min.js`, `*.bundle.js`).

Python files are parsed with tree-sitter, and the same things are recorded for them:

- **HTTP clients:** `requests` (including `Session`), `httpx` (including `Client` and `AsyncClient` with `base_url`) and `aiohttp`;
- **SDKs:** OpenAI, Anthropic, Stripe, Slack (`WebClient`), Twilio and HubSpot.

SHAPI also records URLs of known APIs that no recognized client sends: a project's own request helper, a config object (`baseUrl: "https://..."`), or a connector framework's `url_base` and `path`. Their method is unknown, and they are matched by provider and path. A path that only one provider serves names its provider even when the host is built at runtime: `https://${shop}/admin/api/2026-01/...` is Shopify, also with a runtime version (`/admin/api/${version}/...`), and `/crm-pipelines/v1/...` is HubSpot. In TypeScript and JavaScript, a host whose subdomain is built at runtime names its provider by its fixed suffix: `https://${subdomain}.zendesk.com/...` is Zendesk.

Python call sites are matched against the same advisories. Fixes are proposed for TypeScript and JavaScript only, for now.

For each call site it records the provider, the HTTP method and endpoint (with dynamic segments such as `{owner}`), the file and line, and the **dependency surface**: what the code does with the response. That means the status codes it compares against, the fields it reads, the enum values it switches on, and the headers and query parameters it sends.

The result is the **api.lock**: a reviewable map of your third-party API surface. It is static analysis only; nothing is executed.

## 2. Match: affected or exposed

Each [advisory](/advisories) names an endpoint, what changed, and a **trigger**: what a call site must depend on to break. SHAPI matches the api.lock against the advisories and sorts the hits into two groups:

- **Affected**: the call site depends on exactly what changed, for example `if (res.status !== 204)`.
- **Exposed**: it calls the changed endpoint but does not depend on the change, for example it only checks `res.ok`.
- **Possibly affected**: part of the path is only known at runtime, and the change is narrower than the call. For example `/v24.0/{endpoint}` is affected by Meta's Marketing API v24.0 sunset only if `endpoint` is an ad account (`act_...`). These are listed for you to check and never fail a build.

Only affected call sites are reported as breaking. Deadlines (announced sunsets) within 90 days are listed separately.

## 3. Fix: test-first

For every affected call site that has a fix recipe, SHAPI writes a **contract test**, confirms it fails, applies the fix, and keeps the change only if the test then passes. See [how fixes are verified](/guide/fixes).

## 4. Watch: the GitHub App

The [GitHub App](/guide/github-app) runs all of this on every push to your default branch, posts the result as a `SHAPI` check on the commit, and opens verified fix pull requests. When an advisory is added or changed, it re-checks every installed repository against its stored api.lock, without downloading your code again.

## Where the knowledge comes from

- **Advisories:** reviewed entries in the open [advisory database](/advisories).
- **Canaries:** SHAPI probes the provider APIs it holds its own test accounts for (never with your keys) and records the *shape* of each response (status, field names and types; never the values), so it notices a silent change and can draft a new advisory for review.
- **Recordings:** before and after response shapes for an endpoint, used to build a contract test when the advisory's fix doesn't describe the change by itself.
