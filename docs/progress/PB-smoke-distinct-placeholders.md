# Rename contract tests: a distinct value per field

## Why

The launch smoke test (2026-10-30) found the bug. A function on the demo repo reads a Stripe Checkout Session like this:

```ts
if (session.ui_mode === "embedded") return session.client_secret;
return session.url;
```

`shapi-cli fix` reported it as `ALREADY-HANDLED`, so it opened no fix, for a verified advisory with a deterministic recipe.

The same-result contract test for renamed fields and enum values filled every string field with one placeholder, `"shapi text"`. With the old response the function returned `client_secret`; with the new one it returned `url`. Both were `"shapi text"`, so the results looked equal and the test passed.

## What changes

- `renamePair` (`packages/repair/src/contract.ts`) gives each leaf field the code reads its own value, `shapi <path>`.
- A renamed field keeps the same value under its new name, so code that reads the new name still gives the same result.
- Enum fields still get the old and new enum values.

## Verified

- New test: the Stripe `ui_mode` case gives the old and new bodies distinct `client_secret` and `url` values. The rename test now checks the old body too.
- `packages/repair`: all tests pass.
- On a throwaway clone of shapi-demo with the call added, a local build now reports `FIXED … via recipe (apply-fix)`.
  - The recipe rewrites the comparison to accept `embedded` and `embedded_page`.
  - The repo's tests pass with the generated contract test.

## Not done

- **The request side.** The advisory's `fix` has only response enums, so the request still sends `ui_mode: "embedded"`, which fails once the account moves to 2026-03-25.dahlia. That needs a `fix.body` entry in the advisory and a contract test that checks both the request and the response, which is a separate change.
- **The published CLI is behind.** `shapi-cli@0.3.1` (published 2026-10-29 06:40 UTC) predates "scans skip SHAPI's own contract tests" (6c3b21f). So after a SHAPI fix PR is merged, `npx shapi-cli scan` flags the generated test as a HIGH finding. It is fixed on main and needs a release.
