# PB-40: A fix may not edit, remove or skip the repository's tests (execution plan V-02)

## Why

V-01 rejects a fix that makes a passing test fail, but two easy ways around it were still open:

- **Editing the tests.** Claude could write any source file, test files included (`*.test.ts`, `test/`), so it could weaken a test to make its own fix pass.
- **Running fewer tests.** A fix that deletes or skips tests still "passes".

## What changes

- **Claude can't write the repository's tests:** `refuseWrite` rejects `*.test.*` and `*.spec.*` files, and any file under a `test`, `tests`, `__tests__`, `spec` or `e2e` folder. This sits beside the existing rules for contract tests, config, setup files, mocks, type declarations and CI.
- **Fewer tests is a failure:** `checkSuite` compares how many tests ran before and after the change (`testTotal`: Jest's total, otherwise the sum of the runner's counts, skipped tests included). If fewer ran after, the check fails, so every fix for the advisory is rejected.

## Verified

- **`agent.test.ts`:** five new write targets are refused: `src/deploy.test.ts`, `src/deploy.spec.js`, `test/billing.ts`, `src/__tests__/deploy.ts` and `e2e/deploy.mjs`.
- **`suite.test.ts`:** `testTotal` handles four runners, and a change after which 2 of 3 tests run is rejected even though all of them pass.
- **Full suite:** typecheck and lint are clean, and the full suite passes.
