# How SHAPI works

Third-party APIs change behavior without a new version number. GitHub's `workflow_dispatch` started answering `200` with a body instead of `204`. QuickBooks began answering every minor version below 75 as 75. HubSpot retired its v1 pipelines API. Code written against the old behavior keeps compiling and breaks at runtime. SHAPI finds that code before your users do.

## 1. Map: the api.lock

SHAPI parses your TypeScript and JavaScript with the TypeScript compiler (through ts-morph) and finds every call to a third-party API:

- **HTTP clients:** `fetch`, axios, got, undici, ky, node-fetch
- **official SDKs** of the providers it knows, for example `@octokit/rest`, `stripe` and `@hubspot/api-client`.

Python files are parsed with tree-sitter, and the same things are recorded for them:

- **HTTP clients:** `requests` (including `Session`), `httpx` (including `Client` and `AsyncClient` with `base_url`) and `aiohttp`;
- **SDKs:** OpenAI, Anthropic, Stripe, Slack (`WebClient`), Twilio and HubSpot.

Python call sites are matched against the same advisories. Fixes are proposed for TypeScript and JavaScript only, for now.

For each call site it records the provider, the HTTP method and endpoint (with dynamic segments such as `{owner}`), the file and line, and the **dependency surface**: what the code does with the response. That means the status codes it compares against, the fields it reads, the enum values it switches on, and the headers and query parameters it sends.

The result is the **api.lock**: a reviewable map of your third-party API surface. It is static analysis only; nothing is executed.

## 2. Match: affected or exposed

Each [advisory](/advisories) names an endpoint, what changed, and a **trigger**: what a call site must depend on to break. SHAPI matches the api.lock against the advisories and sorts the hits into two groups:

- **Affected**: the call site depends on exactly what changed, for example `if (res.status !== 204)`.
- **Exposed**: it calls the changed endpoint but does not depend on the change, for example it only checks `res.ok`.

Only affected call sites are reported as breaking. Deadlines (announced sunsets) within 90 days are listed separately.

## 3. Fix: test-first

For every affected call site that has a fix recipe, SHAPI writes a **contract test**, confirms it fails, applies the fix, and keeps the change only if the test then passes. See [how fixes are verified](/guide/fixes).

## 4. Watch: the GitHub App

The [GitHub App](/guide/github-app) runs all of this on every push to your default branch, posts the result as a `SHAPI` check on the commit, and opens verified fix pull requests. When an advisory is added or changed, it re-checks every installed repository against its stored api.lock, without downloading your code again.

## Where the knowledge comes from

- **Advisories:** reviewed entries in the open [advisory database](/advisories).
- **Canaries:** SHAPI probes provider APIs with its own accounts and records the *shape* of each response (status, field names and types; never the values), so it notices a silent change and can draft a new advisory for review.
- **Recordings:** before and after response shapes for each advisory, used to build the contract tests.
