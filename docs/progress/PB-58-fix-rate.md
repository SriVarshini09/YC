# PB-58: The benchmark measures the fix rate in the sandbox (execution plan P-02)

## Why

The benchmark measured flag recall and fixed-state precision, but not whether SHAPI can fix what it flags. The fix rate was `null`.

## What changes

- **`bench:run -- --fix`:** every instance flagged `affected` at its base commit is fixed by SHAPI in a sandbox, the same way the GitHub App's fix job does it (`packages/bench/scripts/fix.ts`):
  - the repository at the base commit goes into E2B (when `E2B_API_KEY` is set);
  - dependencies install with only the npm registry reachable, then the network is cut;
  - SHAPI repairs each affected call site test-first: recipes, then Claude, at most `--llm-calls` calls for the run (40 by default).
- **Results:** each instance gets `fixOutcome` (`fixed`, `partial`, `not-fixed`, `error`) and `fixDetail`. The summary gets `fixRate` with `k`, `n` and a Wilson interval, and `fixErrors` for sandbox and install failures, which are left out of the rate.
- **`withRepoAt()`** extracts a repository at a commit for any step, and `scanRepo()` now uses it.
- **Claude through a gateway:** `ANTHROPIC_BASE_URL` and `SHAPI_REPAIR_MODEL` route the fixer through Vercel AI Gateway. Every request option the fixer uses was checked there first.
- **`METHODOLOGY.md`** defines the fix rate and records the first run.

## Results

First run, in E2B: **0 of 4 fixed** (95% interval 0–49%), 1 install failure, no Claude calls. Every instance stopped before a fix could be tried:

- 2 are Python, which SHAPI doesn't fix yet;
- 1 call site is outside an exported function;
- 1 repository has no root `package.json`, so vitest wasn't installed;
- 1 `npm ci` failed.

## Verified

- **Unit test:** the fix rate counts fixes tried and leaves sandbox failures out. Without `--fix` it stays `null`.
- **Real run:** `results/0.3.1/37fa931e8278.json` holds the full run with every instance's fix outcome.
- **Regression gate:** unchanged. CI runs without `--fix`, and the gate still passes.
- **Full suite:** typecheck, lint and tests pass.
