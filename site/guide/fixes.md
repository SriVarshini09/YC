# How fixes are verified

SHAPI only proposes a change it has proven. The proof is a **contract test**, and it is part of every fix.

## The contract test

For an affected call site, SHAPI generates a test file such as `test/shapi/github-workflow-dispatch-204-to-200.test.ts`. It calls the function that makes the request, with the HTTP client replaced by a stub. The test works with `fetch`, node-fetch, ky, axios, got and provider SDKs such as Stripe and Octokit, and none of them needs to be installed. What the stub answers depends on the change:

- **The request has to change** (a retired path or version, a query value, a header): the stub rejects the old request, so the test passes only once your code sends the new one and still handles the response.
- **A field or enum value was renamed:** your function is called with the old and the new response, and must return the same result for both. A silent rename doesn't crash anything, so this checks what your code actually returns.
- **The response itself changed** (for example a status code): the stub returns the response your code was written for and the one the provider sends now, and your code must handle both.

The test must **fail before the fix**, which proves it reproduces the breakage. If it already passes, SHAPI reports the call site as **already handled** and changes nothing. If it cannot run at all (for example the project does not compile), SHAPI reports that instead of treating it as proof.

## The fix

1. **A deterministic recipe**, if the advisory has one. Recipes are plain code transformations with tests of their own:
   - `status-code-accept-set` rewrites `res.status !== 204` to `![200, 204].includes(res.status)`;
   - `apply-fix` applies the change the advisory spells out, for example moving `/v21.0/` to `/v26.0/` (including in a base URL constant), setting `minorversion=75`, reading `folderIdV2` with `folderId` as a fallback, or accepting a renamed enum value.
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
