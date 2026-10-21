# M1-T3 dependency surface

What exists: every call site now carries a `surface`: response body fields read, status codes compared, whether it checks `.ok`, string values fields are compared to (enums), response headers read, request headers set (API version pins such as `x-github-api-version` or Stripe's `apiVersion`), and request query parameters (QuickBooks `minorversion=65`).
How it works: from the call, the extractor follows the awaited result into a variable, a destructuring pattern, an assignment, a `.then` callback, or an in-place use, then reads property chains on it. Clients are normalized by envelope: fetch (`status`, `ok`, `json()`), axios and Octokit (`status`, `data`), got and undici (`statusCode`, `body`), and body-returning SDKs (Stripe, OpenAI). Comparisons recognized: `===`/`!==`/`==`/`!=`, `switch` cases, `[a, b].includes(x)`.
How to run: `pnpm test packages/extractor` (fixture in `packages/extractor/test/fixtures/surface`).
Not done: dataflow is intra-file and scope-approximate (no type checker); values passed to other functions or returned are not followed; range checks like `status >= 400` are not recorded.
Decisions: fields are recorded as leaf paths (`workflow_runs[].conclusion`); a path stops at JS built-ins (`.map`, `.length`); header names are lowercased.

```
pnpm test packages/extractor
```
