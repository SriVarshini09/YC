# PB-50: A fix may not delete the call or the read of what changed (execution plan V-06)

## Why

A contract test proves the fixed code handles the new response, but a "fix" that deletes the call, the status check or the field read can make that test pass without fixing anything. An LLM fallback could propose exactly that.

## What changes

- **`packages/repair/src/keep.ts`: `checkKept()`.** It reads every file the fix changed twice, before and after the fix, each alone with the repository's package.json, and requires:
  - **the call stays:** a call site with the same provider, method and endpoint, or the endpoint after the advisory's path fix (`/v21.0/` to `/v26.0/`), still exists, in the same file or another file the fix changed;
  - **the read of what changed stays:** what the original call site read or sent and the advisory turns on is still there. That covers the trigger fields (or their renamed versions from the advisory's `fix.fields`), a status check when the trigger is about status codes, the compared enum fields, and the query parameters, headers and body fields named in the trigger.
- **Only removals it can see.** When SHAPI can't find the call in the original files alone (a base URL from another file), the check reports `not-checked` and doesn't reject.
- **`repairCallSite()`.** It runs the check on every change that passes the contract test and the typecheck, recipe or LLM. A change that removes something is a failed attempt ("the test passes, but the change removes the call to …"), and an LLM change is undone. A kept fix carries `keep` in its result.
- **Dependencies.** `@shapi/extractor` becomes a dependency of `@shapi/repair`; it was a dev dependency.
- **Extractor fix.** The check found a gap: SHAPI's own enum fix writes `(["hosted", "hosted_page"] as unknown[]).includes(session.ui_mode)`, which the extractor didn't read as comparing `ui_mode`, so the fixed code looked as if it no longer compared the field. `[…].includes(x)` is now read through parentheses, `as` and `satisfies`.

## Verified

- **Tests:**
  - **The plan's case:** with a contract test that passes no matter what, an LLM "fix" that deletes the GitHub dispatch call is rejected ("removes the call to POST …/dispatches"). One that deletes the `res.status !== 204` check is rejected ("stops checking the status"), and the real fix is kept with `keep: kept`.
  - **Path fix:** a Meta Graph v21.0 to v26.0 path fix is kept.
  - **Field reads:** a change that stops reading the triggered field is rejected, and reading the advisory's renamed field is kept.
  - **No guessing:** a call whose base URL comes from another file is `not-checked`, not rejected.
- **Full suite:** typecheck, lint and the full test suite.
