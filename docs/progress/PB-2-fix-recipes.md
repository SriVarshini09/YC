# PB-2 fix recipes

What exists: one new recipe, **`apply-fix`**, that applies the exact change an advisory lists in its new `fix` field, and contract tests that verify it **without recorded responses**. 10 advisories now carry a fix, up from 1 fixable advisory before.

**The `fix` field** (in the advisory schema here and in the public repo):
- `path`: `{ from, to }`, for example `/v21.0/` to `/v26.0/`, or `/crm-pipelines/v1/pipelines/` to `/crm/pipelines/2026-09/`;
- `query`: `{ name, value }`, for example `minorversion=75`;
- `header`: `{ name, value }`, for example a version header;
- `fields`: `[{ from, to }]` for renamed response fields. A bare name such as `folderId` matches anywhere; a path such as `results[].pipelineId` matches only there;
- `enums`: `[{ field, values: [{ from, to }] }]` for renamed enum values.

**What the recipe changes**, all inside the call's own file:
- **The request.** Path and query rewrites cover the URL argument, same-file `const` strings it's built from (including a base URL that ends at the version, `"https://graph.facebook.com/v21.0"`), axios `baseURL`, `params: { … }` and `headers: { … }`.
- **Response reads**, inside the calling function. `x.old` becomes `(x.new ?? x.old)`, and `=== "old"`, `switch` cases and `[…].includes(x)` also accept the new value.

**How a fix is verified.** The contract test is generated from the fix, so it doesn't need canary data:
- **Request changes:** the stubbed provider answers the retired request with 410, and answers anything else with a body holding every field the code reads, under the new names. The test fails until the code sends the new request and still works.
- **Renames:** the function is called once with the old response and once with the new one, and must return the same result. A silent enum rename doesn't crash, so "doesn't throw" would prove nothing.
- An already-correct call site makes the test pass at baseline and is reported as `already-handled`, with no change made.

**Advisories with a fix.** Every target was checked against the provider:
- QuickBooks `minorversion` → `75`.
- HubSpot Pipelines v1 → `/crm/pipelines/2026-09/{objectType}`, with `pipelineId`/`stageId` → `id`. The path and the response schema come from HubSpot's published OpenAPI spec.
- Meta Graph v20.0 and v21.0, and Marketing API v24.0 and v25.0 → v26.0, the newest Graph version, with no expiry date set.
- Shopify Admin API 2026-01 and 2026-04 → 2026-10, the latest stable, accessible until 2027-10-16.
- Stripe `ui_mode` `hosted`/`embedded`/`custom` → `hosted_page`/`embedded_page`/`elements`.
- HubSpot marketing email `folderId` → `folderIdV2`. Its trigger now also covers list responses (`results[].folderId`).

**Extractor: array items.** Field reads inside `.map`, `.flatMap`, `.filter`, `.find`, `.some`, `.every`, `.forEach` and `.reduce` callbacks, in `for…of` loops, and on `.find()` results are recorded as `field[].child`. Before, `body.results.map((e) => e.folderId)` recorded only `results`, so item-level renames could never match.

**Fix job and CLI:** an advisory with a `fix` doesn't need before/after shapes, and the PR says the test was "built from the advisory's fix and the fields the code reads".

**Demo:** `shapi fix fixtures/demo-ts` fixes **2 of 3**: GitHub (status codes) and QuickBooks (`minorversion`). The HubSpot call site uses axios, which contract tests support from task 3. Until then it's listed as a manual fix.

Verified: 235 tests pass, plus lint and typecheck. New tests cover each fix kind end to end: the baseline fails, the recipe applies, and the test passes. They also cover an axios `params` and header rewrite and the already-handled case.
