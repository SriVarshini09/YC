# How fixes are verified

SHAPI only proposes a change it has proven. The proof is a **contract test**, and it is part of every fix.

## The contract test

For an affected call site, SHAPI takes the response shape the code was written against (**before**) and the shape the provider sends now (**after**), and generates a test file such as `test/shapi/github-workflow-dispatch-204-to-200.test.ts`. The test mocks the HTTP call with each shape, calls your function, and checks that it handles both.

The test must **fail before the fix**, which proves it reproduces the breakage. If it already passes, SHAPI reports the call site as **already handled** and changes nothing. If it cannot run at all (for example the project does not compile), SHAPI reports that instead of treating it as proof.

## The fix

1. **A deterministic recipe**, if the advisory has one. For example, `status-code-accept-set` rewrites `res.status !== 204` to `![200, 204].includes(res.status)`. Recipes are plain code transformations with tests of their own.
2. **Claude**, only if you ask for it (`fix --llm`, or the account setting *Use Claude when no deterministic recipe fits*). Claude gets the affected file, the advisory and the failing test, and proposes a change. It may not touch the test or anything outside your repository.

Either way, the change is kept **only if the contract test then passes**. Otherwise the call site is reported as needing a manual fix, and nothing is changed.

## Where the test runs

- **CLI on your machine (`shapi fix`):** in a temporary copy of your repository, using your installed dependencies. This is your own code on your own machine.
- **GitHub App (hosted):** in a fresh **E2B Firecracker microVM** per job, with its own kernel.
  1. Dependencies install with only the npm and Yarn registries reachable.
  2. The network is switched off completely before any of your code or tests run.
  3. No tokens or SHAPI credentials are inside.
  4. The VM is destroyed after the job and has a hard lifetime limit.

  See [security](/security).

## What a fix PR contains

- The changed source file and the contract test.
- A description: what the provider changed, the affected call site, the recipe or model used, the test run before and after, and the evidence behind the advisory (sources, when it was first observed).
- A commit marked with a `SHAPI-Branch` trailer.

SHAPI never overwrites a branch someone else pushed to, and never reopens a PR you closed without merging. Add the `shapi:stop` label to a PR to stop updates to it.
