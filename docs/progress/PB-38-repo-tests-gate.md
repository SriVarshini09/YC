# PB-38: Fixes must keep the repository's own tests passing (execution plan V-01)

## Why

SHAPI kept a fix when its contract test failed before the fix and passed after it, and the type check passed. That proves the call site handles the provider's change. It doesn't prove the rest of the app still works.

The research is blunt on this point. In one study of an AI agent's library migration, the agent changed 100% of the sites, but the app's tests passed only 40% of the time ([arXiv 2510.26699](https://arxiv.org/abs/2510.26699)). SWE-bench uses the same remedy: it requires the repository's own passing tests to stay passing, which it calls PASS_TO_PASS.

## What changes

- **`Workspace.runSuite()`** (local and sandbox) runs the repository's own test command.
  - It runs the `test` script of the root `package.json` with the repository's package manager: `npm test`, `corepack pnpm test` or `corepack yarn test`.
  - npm's placeholder script doesn't count as a test command.
  - In the sandbox the network is already off.
- **`repairAdvisory`** runs the test command once before any change. After the fixes (and after the existing combined re-run of the contract tests) it runs the command again. SHAPI's own contract tests and its vitest config are set aside during that run, so the repository's runner doesn't count them.
- **`checkSuite`** compares the two runs:
  - **Passed before, fails after:** reruns twice. If a rerun passes, the test is flaky and the fix is kept. If all three runs fail, every fix for the advisory is rejected, with the failing test names as the reason, and no PR opens.
  - **Already failing before:** only tests that newly fail count against the change.
  - **Not run:** no test command, a command that couldn't run any tests, or failing output that names no test to compare. These are reported as not run; a fix is never blocked for them.
  - It reads the counts and failing-test names of vitest, Jest, Mocha and node:test.
- **The PR body** gets a "Your tests" line: either "✅ `npm test` passes with this change (before: N passed; after: N passed)", or "⚪ not run: why". Only the runner's counts and SHAPI's own words appear. Failing test names come from output the repository's code can print to, so they never reach the PR.

## Verified

- **New tests:**
  - `packages/repair/test/suite.test.ts`: command detection, counts and names for four runners, and every comparison case.
  - `packages/repair/test/agent.test.ts`: a recipe fix on the demo repo is kept when its tests pass before and after, with SHAPI's test set aside during the run and put back afterwards. The same fix is rejected when a passing test fails after it, and reported as not run when there is no test command.
  - `packages/github-app/test/body.test.ts`: the PR line.
- **Full suite:** typecheck and lint are clean, and the full suite passes (55 files, 508 tests).

## Not done here

- **Python test commands (pytest)** come with Python fixes (U-03).
- **A guard against fixes that delete tests or lower the test count** is V-02.
