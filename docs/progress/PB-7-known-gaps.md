# PB-7 known gaps: one PR per advisory, deleted advisories, "cancels on"

## One PR per advisory, covering all its call sites

Before, the fix job repaired only an advisory's **first** affected call site, and the PR named how many others there were. The CLI with `--write` had a related bug: each call site was repaired against the original file, so a second fix in the same file overwrote the first.

Now `repairAdvisory()` in `@shapi/repair`:
- repairs every affected call site of an advisory **in one workspace**, each test-first and on top of the fixes before it;
- works bottom-up within a file, so an edit never moves a site still to come;
- gives each call site its own contract test: `test/shapi/<id>.test.ts`, then `<id>.2.test.ts`, …;
- returns one combined change: each source file once, from its original text to its final text, plus every test;
- reports `fixed`, `partial` or `none`.

**The server** opens one PR per advisory with that change. The PR lists every call site as fixed, already handled, or not fixed with the reason. The contract-test table has one row per test, with its run before and after. Call sites it couldn't fix go on the dashboard as manual. The fix report now records `sites: { fixed, total }` per advisory.

**The CLI** (`shapi fix`) groups findings by advisory the same way: one `--write` and one `--pr` per advisory, still with one log line per call site.

## Advisories deleted upstream

`syncAdvisoriesFromGitHub()` now removes advisories that this repository synced before and that are gone from it.
- An advisory from another source (for example the bundled folder) is never touched.
- A file that's still there but **invalid** is not treated as deleted, so a bad edit doesn't wipe an advisory.
- A removal triggers the advisory fan-out like a change does, so findings for the removed advisory go away.
- The sync log lists the removed ids.

## "Cancels on" for billing

A new `billing.cancel_at` column (migration `0007_billing_cancel_at`) is set from Stripe's `cancel_at`, or from the period end when `cancel_at_period_end` is set, and cleared when the subscription ends. A cancelled subscription that is still running now shows **"Cancels on YYYY-MM-DD"** on the plan card instead of "Renews", and says what's covered after that date.

Verified:
- Three call sites in two files become one change, and every generated test passes against it. A partial case keeps the fixable site and reports the other with its reason.
- The CLI `--pr` body lists the call sites and the test table.
- A deleted advisory is removed, an invalid file isn't, and other sources are untouched.
- A `customer.subscription.updated` event with `cancel_at_period_end` shows "Cancels on 2027-01-01", and the deletion clears it.
- 258 tests pass, plus lint and typecheck.
