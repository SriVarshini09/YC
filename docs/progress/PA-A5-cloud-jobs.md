# PA-A5 scan and fix jobs in the cloud

What exists: the worker now runs SHAPI end to end.
- **Triggers:** a push to a repo's default branch queues a scan of that commit, and a newly installed or added repository gets a first scan of its default-branch head. Scans are sent only after the webhook's transaction commits, and the sweeper re-queues scans stuck as queued.
- **`repo-scan`:**
  1. Download the commit with a short-lived token that can only read that repository.
  2. Build the api.lock by static analysis (the code is read, never run).
  3. Match the reviewed advisories.
  4. Store the findings and the advisory versions matched.
  5. Post the `SHAPI` check run: neutral with annotations, or "could not scan" on failure.
- **`repo-fix`** (one running and one waiting per repository):
  1. Repair each affected advisory that has a recipe, test-first, inside one E2B sandbox, using before/after responses from the canary store or SHAPI's recordings.
  2. Deliver the verified fixes through the PR engine.
  3. Advisories without a fix appear on the dashboard as "Needs a manual fix".
  LLM fixes run only for accounts that turn them on (`llmFixes`), because they send code to the model provider.
- **`advisory-fanout`** (after every advisory sync, and daily): re-match each repository's stored api.lock against new or changed advisories without downloading code, and queue a fix job where one hits.

Verified: 203 tests pass, 8 of them new (fake GitHub with real tarballs and check runs, real Postgres). They include the worker running push → scan → fix → PR end to end. Lint, typecheck and build are clean. The Docker image (now with recordings) passed the CI smoke test locally on Postgres 17: migrations, queues, readiness, and the worker's advisory sync and fan-out. GitHub Actions minutes are used up until Nov 1, so CI could not run.
Live check, 2026-10-22, on `shapi-demo` (GitHub App, smee, E2B):
1. A commit putting the 204-only check back on main (`7d926cb`) arrived as a push webhook and queued scan 69.
2. The scan found 5 call sites, 3 affected, and posted a neutral `SHAPI` check with 3 annotations on the commit.
3. The fix job repaired the GitHub one in E2B sandbox `iz0fi1vrielm8cmvbwbrg`, opened shapi-demo PR #7 (labeled `shapi`, `![200, 204].includes(res.status)`, verified-in trailer), and listed QuickBooks and HubSpot as having no recipe. No sandbox was left running.
4. Closing #7 was recorded. The revert (`09df375`) was scanned, the GitHub call site became exposed (2 affected), and no PR was opened.
Two side notes: the dashboard stayed closed because issue #4 had been closed (by design), and shapi-demo's own CI could not start because it is private and out of Actions minutes.
Not done: scanning only changed files, and several affected call sites of one advisory fixed in one PR.

```
pnpm test
pnpm build && pnpm --filter @shapi/server dev     # local server with the GitHub App; E2B if .shapi/e2b.env exists
```
