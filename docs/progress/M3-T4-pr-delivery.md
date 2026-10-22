# M3-T4 PR delivery and `shapi fix`

What exists: `packages/github-app` opens a fix PR through the Git data API (commit on `shapi/<advisory-id>` off the default branch, then the PR; no local clone needed), keeps each file's line endings from the base branch, and writes a PR body with the change, the contract test's before/after results, and an evidence table (advisory, severity, first observed, provider notice, shape source, blast radius, sources). Auth: a GitHub App when `SHAPI_GITHUB_APP_ID`, `SHAPI_GITHUB_APP_INSTALLATION_ID` and `SHAPI_GITHUB_APP_PRIVATE_KEY(_PATH)` are set; otherwise `GITHUB_TOKEN`/`GH_TOKEN`; otherwise the `gh` login. `shapi fix [path] | --repo <url>` scans the repo, finds before/after shapes (canary store first, then `fixtures/recordings`), runs the repair agent per affected call site, and then reports, `--write`s, or opens a PR with `--pr`. It exits 1 when a finding wasn't fixed. The README documents fix and canary.
End to end: `npx shapi fix --repo https://github.com/SriVarshini09/shapi-demo --pr` opened [shapi-demo PR #2](https://github.com/SriVarshini09/shapi-demo/pull/2): one line in `src/deploy.ts` plus the contract test, and the repo's CI (`npm test`) passes on it. PR #1 was closed: it rewrote every line because the Windows checkout had CRLF line endings, now fixed (clone with `core.autocrlf=false`, match the base file's endings).
Not done: one PR per call site (several call sites for one advisory become several PRs); QuickBooks and HubSpot findings are skipped until their endpoints have recorded shapes; the GitHub App itself is not registered.
Decisions: PRs go out only for `fixed` results, and the body states the test failed before and passes after.

```
npx shapi fix --repo https://github.com/SriVarshini09/shapi-demo --pr
```
