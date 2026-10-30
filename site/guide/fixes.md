---
description: "How SHAPI proves a fix: a contract test that fails before the change and passes after it, run in a sandbox."
---

# How fixes are verified

SHAPI only proposes a change it has proven. The proof is a **contract test**, and it is part of every fix.

## The contract test

For an affected call site, SHAPI generates a test file such as `test/shapi/github-workflow-dispatch-204-to-200.test.ts`. It calls the function that makes the request, with the HTTP client replaced by a stub. The test works with `fetch`, node-fetch, ky, axios, got and provider SDKs such as Stripe and Octokit, and none of them needs to be installed. What the stub answers depends on the change:

- **The request has to change** (a retired path or version, a query value, a header): the stub rejects the old request, so the test passes only once your code sends the new one and still handles the response.
- **A field or enum value was renamed:** your function is called with the old and the new response, and must return the same result for both. A silent rename doesn't crash anything, so this checks what your code actually returns. A function that returns nothing gives nothing to compare, so SHAPI reports it as one it cannot test rather than as already handled.
- **The response itself changed** (for example a status code): the stub returns the response your code was written for and the one the provider sends now, and your code must handle both without an error. This checks that it runs, not what it returns.

The test must **fail before the fix, and fail the way the advisory says**: on the old request, on the new response, or with a different result. That proves it reproduces the breakage. If it already passes, SHAPI reports the call site as **already handled** and changes nothing. If it cannot run at all (for example the project does not compile), or fails for another reason (the generated arguments, a missing setting), SHAPI reports that instead of treating it as proof.

The test runs whatever your vitest config's `include` says: SHAPI runs it with your config, aliases and setup files included, and only its own test selected.

## The fix

1. **A deterministic recipe**, if the advisory has one. Recipes are plain code transformations with tests of their own:
   - `status-code-accept-set` rewrites `res.status !== 204` to `![200, 204].includes(res.status)`;
   - `apply-fix` applies the change the advisory spells out, for example moving `/v21.0/` to `/v26.0/` (including in a base URL constant), setting `minorversion=75`, reading `folderIdV2` with `folderId` as a fallback, accepting a renamed enum value, or changing a request body field (a retired model, a renamed parameter such as `max_tokens` to `max_completion_tokens`, or one to stop sending). Changes an advisory pairs, such as a model swap with the parameter the new model needs, or a version bump with the field it renamed, go in one fix and one contract test.
2. **Claude**, only if you ask for it (`fix --llm`, or the account setting *Use Claude when no deterministic recipe fits*, shown when Claude is enabled on the server). Claude gets the affected file, the advisory, the failing test and its output, and proposes a change. It may change only source files: not the contract tests, configuration (`package.json`, `tsconfig.json`, vitest or other `*.config.*` files), setup files, mocks, type declarations, CI, or anything outside your repository. The GitHub App makes at most 20 Claude calls per fix job (retries of the same job share them; every new fix job, from a push, a dashboard tick or a new advisory, has its own), and `fix --llm` at most 20 per run (`SHAPI_LLM_CALLS_PER_JOB` changes both), and a file over 200 kB is not sent.

Either way, the change is kept **only if the contract test then passes** and, in a TypeScript repository, **`tsc --noEmit` with your nearest `tsconfig.json` reports no new errors** (vitest itself does not type-check). Errors your code already had don't count against the fix. If TypeScript isn't installed or there is no tsconfig, the fix is kept and the result says it was not type-checked. Otherwise the call site is reported as needing a manual fix, and nothing is changed.

When an advisory has several call sites, every site's test runs again on the combined change; a site whose test no longer passes is not reported as fixed.

## Python

A Python call site gets the same steps, with a contract test written for Python: `test/shapi/test_<advisory>.py`, using the standard library only, so pytest runs it and so does `python test/shapi/test_<advisory>.py`. It imports your module, sets the environment variables the function reads to placeholders, and calls the function while `urllib`, `requests` and `httpx` are stubbed: every request is recorded and none leaves the machine, and each one is answered with a JSON object holding every key the function reads.

- **The request has to change** (a retired path, query value or header): the test fails if the function sends the retired request. It checks what was sent, so it works even when your code catches every error.
- **The status code changed:** the function runs against the old and the new status, and must return the same result for both without an error.

If the function returns before it calls the endpoint (for example on a missing setting the test does not know about), SHAPI says it cannot test the call rather than claiming a fix.

The two deterministic recipes work on Python: `apply-fix` rewrites the URL (a string, an f-string, a concatenation, or a name assigned one), the `params=` and `headers=` dicts, and body fields in an SDK call's keyword arguments or a `json=` dict; `status-code-accept-set` turns `resp.status_code != 204` into `resp.status_code not in (200, 204)`. For now Python fixes are not type-checked, Claude is not asked to fix Python, and your repository's own Python tests are not run: they need its dependencies from PyPI, which the sandbox does not reach.

## Where the test runs

- **CLI on your machine (`shapi fix`):** in a temporary copy of your repository, using your installed dependencies, deleted when the run ends. Tests run without your environment's tokens and keys. This is your own code on your own machine.
- **GitHub App (hosted):** in a fresh **E2B Firecracker microVM** per job, with its own kernel.
  1. Dependencies install with only the npm and Yarn registries reachable.
  2. The network is limited to the package registries during the dependency install (install scripts run then), and switched off completely before your code or tests run.
  3. No tokens or SHAPI credentials are inside.
  4. The VM is destroyed after the job. It starts with a 15-minute lifetime, extended before each install, test and type-check, never past 60 minutes; a job that would need longer stops with an error instead.

  See [security](/security).

## What a fix PR contains

- The changed source file and the contract test.
- A description: what the provider changed, the affected call site, the recipe or model used (with Claude's explanation of its change; it and any code, file path or test output from your repository are shown as plain text), the test run before and after, the type-check result, and the evidence behind the advisory (sources, when it was first observed).
- A commit marked with `SHAPI-Branch` and `SHAPI-Tree` trailers, built on the commit SHAPI scanned. Pushes to your default branch since then are merged by GitHub as usual, or show as a conflict; the PR never reverts them.

A fix PR opens as a draft unless its recipe, provider and kind of change have earned the AUTO tier on the benchmark; see [Fix tiers](./fix-tiers).

SHAPI never overwrites a branch someone else pushed to (an amended commit counts), and never reopens a PR you closed without merging. Add the `shapi:stop` label to a PR to stop updates to it.
