---
description: "Signed attestations on SHAPI fix PRs: the test result and the fix, over the files the PR changes, made with actions/attest and checked with gh attestation verify."
---

# Signed attestations

A SHAPI fix PR can carry two signed attestations over the files it changes:

- **The test result** (`https://in-toto.io/attestation/test-result/v0.1`): your repository's tests on the PR's head commit, by name: passed, skipped and failed.
- **The fix** (`https://shapi.dev/attestation/api-fix/v0.1`):
  - which advisory the PR fixes, with links to its page and OSV record;
  - the PR and its head commit;
  - each changed file with its SHA-256;
  - SHAPI's contract tests and their results.

They are made in your repository's own GitHub Actions run with [`actions/attest`](https://github.com/actions/attest), signed through Sigstore with the workflow's identity. Anyone can check them with the GitHub CLI.

## Set it up

Add this workflow to `.github/workflows/shapi-attest.yml`, and the script below to `.github/shapi/predicates.mjs`. It runs on every pull request from a `shapi/` branch. You can also run it by hand with a PR number, to attest a SHAPI PR opened before you added it.

```yaml
name: SHAPI attestations
on:
  pull_request:
  workflow_dispatch:
    inputs:
      pr:
        description: Number of the SHAPI pull request to attest
        required: true
permissions:
  contents: read
  pull-requests: read
  id-token: write
  attestations: write
jobs:
  attest:
    if: github.event_name == 'workflow_dispatch' || startsWith(github.head_ref, 'shapi/')
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
      PR: ${{ github.event.number || inputs.pr }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Check out the pull request's head commit
        id: pr
        run: |
          cp .github/shapi/predicates.mjs "$RUNNER_TEMP/predicates.mjs"
          gh pr view "$PR" --json number,url,headRefOid,headRefName,files > "$RUNNER_TEMP/pr.json"
          git checkout -q "$(jq -r .headRefOid "$RUNNER_TEMP/pr.json")"
          jq -r '.files[].path' "$RUNNER_TEMP/pr.json" | while read -r f; do [ -f "$f" ] && echo "$f"; done > "$RUNNER_TEMP/subjects.txt"
          { echo "subjects<<EOF"; cat "$RUNNER_TEMP/subjects.txt"; echo "EOF"; } >> "$GITHUB_OUTPUT"
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm install --no-audit --no-fund
      - name: Run the tests
        continue-on-error: true
        run: npx vitest run --reporter=json --outputFile="$RUNNER_TEMP/vitest.json"
      - name: Write the predicates
        run: node "$RUNNER_TEMP/predicates.mjs" "$RUNNER_TEMP"
        env:
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
      - uses: actions/attest@v4
        with:
          subject-path: ${{ steps.pr.outputs.subjects }}
          predicate-type: https://in-toto.io/attestation/test-result/v0.1
          predicate-path: ${{ runner.temp }}/test-result.json
      - uses: actions/attest@v4
        with:
          subject-path: ${{ steps.pr.outputs.subjects }}
          predicate-type: https://shapi.dev/attestation/api-fix/v0.1
          predicate-path: ${{ runner.temp }}/api-fix.json
```

The script turns the PR and vitest's JSON report into the two predicates. It's in the [demo repository](https://github.com/SriVarshini09/shapi-demo/blob/main/.github/shapi/predicates.mjs); copy it as it is. For another test runner, change the lines that read `vitest.json`.

Attestations need a public repository, or a private one on GitHub Enterprise Cloud.

## Check one

Check out the PR's head commit (or download one of the files it changed), then:

```bash
gh attestation verify src/accounting.ts --repo SriVarshini09/shapi-demo --predicate-type https://shapi.dev/attestation/api-fix/v0.1
```

The command exits 0 when the file's digest matches a signed attestation of that type from the repository's own workflow. It exits 1 when the file differs by even one byte. Add `--format json` to read the predicate itself.

## The fix predicate

```json
{
  "advisory": { "id": "quickbooks-minorversion-below-75-ignored", "url": "https://shapi.dev/advisories/quickbooks-minorversion-below-75-ignored", "osv": "https://shapi.dev/osv/quickbooks-minorversion-below-75-ignored.json" },
  "pullRequest": { "number": 9, "url": "https://github.com/SriVarshini09/shapi-demo/pull/9", "head": "926091528add5916118742eaf4df0c67f90539cd" },
  "changedFiles": [{ "path": "src/accounting.ts", "sha256": "5d3606f3…" }],
  "contractTests": [{ "file": "test/shapi/quickbooks-minorversion-below-75-ignored.test.ts", "name": "…", "status": "passed" }],
  "result": "PASSED",
  "verifiedBy": "https://github.com/SriVarshini09/shapi-demo/actions/runs/…"
}
```
