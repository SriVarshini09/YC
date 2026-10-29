# PB-27: Python extractor follow-ups to the TypeScript fixes

## Why

The TypeScript extractor fixes (PB-25) changed rules that the Python extractor shares, and `packages/extractor/src/python.ts` still used the old ones:

- `f"https://{sub}.zendesk.com/api/v2/tickets"` got no provider. The TypeScript side names it from the host's fixed suffix (`runtimeHost`), but Python called `providerOf(host, path)` without it.
- SDK sites of a provider with per-tenant hosts got the first fixed host as their host (a Twilio SDK call recorded `api.twilio.com`). The TypeScript side leaves `host` null for any provider whose hosts include a `*.` pattern.
- `resp.status_code >= 400` recorded 400 as a status code the code depends on, and `data["state"] > "m"` recorded `"m"` as an enum value. The TypeScript side records only equality and membership comparisons.
- `from aiohttp import web; web.get("/x", handler)` defines a server route, but it was recorded as an aiohttp GET call site.

## What changes

`packages/extractor/src/python.ts`:
- HTTP calls and loose URLs pass `runtimeHost` to `providerOf`, as `callsites.ts` does.
- An SDK site's `host` is null when the provider has a `*.` host, else its first host, as on the TypeScript side.
- `comparedLiterals` returns literals only for `==`, `!=`, `in` and `not in`, so orderings record neither status codes nor enum values. (Python has no `match`/`case` handling, so there is nothing to align there.)
- `aiohttp.web` (`from aiohttp import web`, `import aiohttp.web as web`) is not bound as an HTTP client module. `app.router.add_get(...)` was already not a call site; the test now covers it.

Loose URLs already follow the contract documented in `packages/core/src/lockfile.ts` (`resolved: true`, `method: null`); the runtime-host test now asserts it.

`site/guide/how-it-works.md`: the runtime-host suffix rule is no longer described as TypeScript-only.

## Verified

- `packages/extractor/test/python.test.ts`, under "Python edge cases":
  - names the provider of a host built at runtime from its fixed suffix (also checks a loose URL's `resolved`);
  - leaves the host null on SDK calls of a provider with per-tenant hosts;
  - records status codes only for ==, != and in comparisons, not orderings;
  - does not take aiohttp.web route definitions for HTTP calls.
- Each new test fails with the old `python.ts` put back.
- Typecheck, lint and the extractor tests (61) pass.
