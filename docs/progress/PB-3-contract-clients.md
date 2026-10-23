# PB-3 contract tests beyond fetch

What exists: generated contract tests work for **fetch, node-fetch, ky, axios, got and provider SDKs** (Stripe, Octokit and any other SDK in the provider registry). None of these packages needs to be installed, because the test replaces the client with a fake. The demo now fixes **3 of 3** findings.

How it works: every generated test shares one `respond(request)` hook, and the call site's client is replaced so that each request goes through it.
- **fetch, ky:** global `fetch` is stubbed. **node-fetch:** the module is mocked to call that same stub.
- **axios:** `vi.mock("axios")` with a fake that covers the default export, instances from `axios.create({ baseURL, headers })`, `get`/`delete`/`head`/`options`, `post`/`put`/`patch`, `request`, `params` and `headers`. It throws an `AxiosError` with `response` on non-2xx, like axios, and has `interceptors` and `isAxiosError`.
- **got:** `vi.mock("got")` with `got(url, options)`, `got.get`/`post`/…, `.json()`/`.text()`/`.buffer()`, `prefixUrl`, `searchParams`, `responseType: "json"`, `extend` and `HTTPError` (unless `throwHttpErrors: false`).
- **SDKs:** `vi.mock(<package>)` replaces the default export and every named import with a client in which any method chain resolves to the call site's endpoint. Octokit gets `{ status, data, headers }`; body-returning SDKs such as Stripe get the parsed body. Error statuses throw an error with `status` and `statusCode`.

The three kinds of test from PB-2 (retired request, same result for old and new response, recorded before and after) run on any of these clients. A request fix on an SDK call is refused with a reason, because the SDK builds the request itself and a path or header rewrite in the code wouldn't change it.

Smaller changes:
- **Extractor:** got and ky `searchParams: { … }` are recorded as query parameters, as axios `params` already were.
- **Recipe:** `apply-fix` also rewrites query values in got's `searchParams`.
- **Stripe's SDK map:** `checkout.sessions.retrieve` → `GET /v1/checkout/sessions/{session}`.
- **Docs:** the "How fixes are verified" page describes the three kinds of test and the supported clients.

Verified, with each case going through the full repair flow (the generated test fails, the recipe applies, the test passes):
- the demo's HubSpot call on an axios instance with `baseURL` (`/crm-pipelines/v1/pipelines/deals` → `/crm/pipelines/2026-09/deals`);
- a got QuickBooks query with `searchParams: { minorversion: 65 }` → 75;
- a Stripe SDK `checkout.sessions.retrieve` whose `ui_mode` comparison now accepts `hosted_page`;
- an Octokit `createWorkflowDispatch` whose `res.status !== 204` check accepts 200, from the recorded responses.

Also verified:
- `shapi fix fixtures/demo-ts` reports **FIXED** for all three call sites.
- The hosted fix job fixes all three. Two PRs open at once and the third waits on the dashboard, because of the 2-new-PRs-per-hour limit.
- 240 tests pass, plus lint and typecheck.
