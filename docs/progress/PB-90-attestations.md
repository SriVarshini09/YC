# PB-90: Signed attestations on SHAPI fix PRs (execution plan S-04)

## Why

A fix PR says "contract test failed before, passes after; your tests 4/4". An attestation lets anyone check that claim cryptographically, tied to the exact files and the repository's own workflow. They don't have to trust SHAPI's PR text.

## What changes

- **In the demo repository** ([shapi-demo#11](https://github.com/SriVarshini09/shapi-demo/pull/11), [#12](https://github.com/SriVarshini09/shapi-demo/pull/12)), `.github/workflows/shapi-attest.yml` runs on every `shapi/` PR, or by hand with a PR number. It runs the tests on the PR's head commit and makes two signed attestations over the files the PR changed, with `actions/attest`:
  - **`https://in-toto.io/attestation/test-result/v0.1`:** `result`, `passedTests`, `warnedTests` and `failedTests` by name; the `configuration` is `package.json` with its digest; `url` is the Actions run.
  - **`https://shapi.dev/attestation/api-fix/v0.1`:**
    - the advisory (id, page, OSV);
    - the PR and its head commit;
    - each changed file with its SHA-256;
    - the contract tests with their status;
    - an overall result, and the run that verified it.
- **Script:** `.github/shapi/predicates.mjs` writes both predicates from `gh pr view` and vitest's JSON report. It's copied aside before checking out an older PR's head commit, which predates it.
- **Docs:** the [Signed attestations](https://shapi.dev/guide/attestations) page in SHAPI's docs is the `actions/attest` recipe: the workflow, where the script lives, how to verify, and the predicate's shape. It's linked from the GitHub App page.

## Transcript (reproducible)

Attesting [shapi-demo#9](https://github.com/SriVarshini09/shapi-demo/pull/9), the QuickBooks minorversion fix, by hand ([run](https://github.com/SriVarshini09/shapi-demo/actions/runs/41151447807)) gave:

```
test-result PASSED: 4 passed, 0 failed; api-fix PASSED for quickbooks-minorversion-below-75-ignored
Attestation created for 2 subjects  https://github.com/SriVarshini09/shapi-demo/attestations/61991992
Attestation created for 2 subjects  https://github.com/SriVarshini09/shapi-demo/attestations/61992003
```

Then, with `src/accounting.ts` as it is at the PR's head commit `9260915`:

```
$ gh attestation verify src/accounting.ts --repo SriVarshini09/shapi-demo --predicate-type https://in-toto.io/attestation/test-result/v0.1
exit 0
$ gh attestation verify src/accounting.ts --repo SriVarshini09/shapi-demo --predicate-type https://shapi.dev/attestation/api-fix/v0.1
exit 0
$ echo "// tampered" >> src/accounting.ts && gh attestation verify src/accounting.ts --repo SriVarshini09/shapi-demo --predicate-type https://shapi.dev/attestation/api-fix/v0.1
exit 1
```

## Not done

- **The GitHub App doesn't add the workflow to customer repositories.** That would need write access to workflows, a permission SHAPI doesn't ask for. Customers add it from the docs page.
