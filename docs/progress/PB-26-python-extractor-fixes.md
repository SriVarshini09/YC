# PB-26: Python extractor fixes (full review, section C)

## Why

The full code review (review 3, "Python extraction") found Python code shapes the extractor misread. Each one either dropped a call site, recorded a wrong one, or declared the wrong providers:

- `from httpx import Client` / `from requests import Session` / `from aiohttp import ClientSession`: a client constructed by its bare name was not recognized, so its calls became loose, method-less URL sites (or nothing).
- URLs built with `"...{}...".format(x)` or `"...%s..." % x` had no provider and no endpoint.
- `import openai.types` rebound `openai` to the submodule, so every later `openai.*` call was dropped.
- `client.headers.get("Authorization")` and `client.cookies.get(...)` were recorded as HTTP GET call sites (`GET /Authorization`).
- `client.get(path_var)` on a `base_url` client recorded the base itself (`/v24.0`), so advisories under it could not even be "possible".
- `client.toString()` on an SDK client hit `Object.prototype.toString` in the method table and the whole file was skipped.
- `data["error_code"] == 30036` recorded the field but no enum value, so numeric enum triggers (Twilio's error codes) could never fire.
- pyproject.toml: any `key = [...]` list counted as dependencies (`keywords = ["stripe"]` declared Stripe), and `"anthropic[vertex]>=0.3"` ended the list, so the dependencies after it were missed.

## What changes

`packages/extractor/src/python.ts`:
- A `from <http lib> import X` binding remembers `X`, so `X(...)` is a constructor call like `httpx.Client(...)`.
- `import a.b` binds `a` to the package `a`, as Python does; `import a.b as x` still binds `x` to `a.b`.
- An HTTP call's client is the whole chain but the verb (`c.get`, `self.http.get`), so `c.headers.get(...)` is not a request.
- `evalString` evaluates `.format(...)` (`{}`, `{0}`, `{name}`, `{{`) and `%` (`%s`, `%d`, `%(name)s`, `%%`); unknown values become placeholders like in f-strings. Loose-URL detection treats `%` like `+`.
- An unknown path on a `base_url` client is a runtime segment: `/v24.0/{}`.
- The SDK method table is read by own property only.
- A number compared to a body field with `==`, `!=`, `in` or `not in` is recorded as an enum value, as its decimal text (`"30036"`). Ordering comparisons (`> 1`) are not enum values.

`packages/extractor/src/files.ts`: pyproject.toml lists count only when they are `dependencies`, `optional-dependencies` or `dev-dependencies`, or sit under `[project.optional-dependencies]`, `[dependency-groups]` or a `dev-dependencies` table. Brackets inside quotes don't end a list. Poetry `[...dependencies]` tables are read as before.

## Verified

- New tests in `packages/extractor/test/python.test.ts` ("Python edge cases"), one per finding; each failed before the change.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` (303 tests) pass.
