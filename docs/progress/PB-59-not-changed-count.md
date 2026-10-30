# PB-59: "Not changed (N)" lists every inspected call site (execution plan D-02)

## Why

D-01 added the "Not changed" section to fix PRs. D-02's test is that it lists every call site SHAPI inspected and left alone, with a reason: its count equals the advisory's exposed plus possible call sites.

## What changes

- **A test, no code change.** The fix job already builds the list from the scan's match (`notChangedFor` in `apps/server/src/jobs/fix.ts`). An end-to-end test now holds it to D-02's rule.
- **`setup()` in `cloud.test.ts` takes extra files**, so a test can add a call site to the demo repository.

## Verified

- **End-to-end test** (`apps/server/test/cloud.test.ts`):
  - the demo repository gets a second workflow dispatch call that never reads the status (exposed, not affected);
  - it runs push → scan → fix → PR;
  - for every PR opened, `Not changed (N)` equals the advisory's exposed plus possible call sites from the stored scan;
  - each one is listed with its file, line and SHAPI's reason;
  - the new call site is among them, so the check isn't vacuous.
- **Full suite:** typecheck, lint and tests pass.
