# PB-34: Fixes from review 8

## Why

Review 8 read the follow-up fix PRs #78–#85 together. Its findings:

- **#1 (medium):** the LLM budget was kept on the scan (PB-32). Every fix job on the same scan spent it, not only retries: a dashboard "open now" or "open again" tick, lifting a pause, or the advisory fan-out got no Claude fixes once the scan's 20 calls were used.
- **#2 (medium):** an organization owner who signed in while the installation webhook was still being processed was in no admin check: every repository was created after the session, so none counted, and Settings and Billing were missing for the whole 8-hour session with no notice.
- **#3 (low):** the "N repositories were added since you signed in" notice told a member how many repositories they cannot open had been added, and that signing in again would show them, which it would not.
- **#4 (low):** the PR body's Before/After cells took the first `Tests … (n)` match anywhere in the test run's output. A line the code under test printed could put a link, image or mention into a verified PR.
- **#5 (low):** the advisory fan-out saved findings under the account it read at the start, so a transfer committed meanwhile left the new findings (and the Slack notice) with the old account.
- **#6 (low):** "latest scan" is the last one queued. A push delivered late (redelivered after an outage) made its older commit the latest: the web showed it, the fix job built PRs on it, and the fan-out re-matched it.
- **Minor items:**
  - security.md said "a fix job makes at most 20 Claude calls" while the budget was per scan.
  - A call whose model comes from a variable (REST Gemini `…/models/${model}:generateContent`, or an SDK call with `model` from a variable) was "exposed … does not depend on the changed behavior", though SHAPI cannot tell the model.
  - `scripts/run-ts.mjs` turned a child killed by a signal into exit 1, and it added a process between pnpm and the script: stopping the preview left the script and its Postgres running.
  - Migration 0014 has no `lock_timeout`.
  - The test Postgres start limit (30 s) was fixed in code.
  - Ticking "open again" on a "Needs you" row without deleting the branch re-rendered the box unticked with no explanation.

## What changes

- **#1:**
  - Migration **0015_fix_job_llm_calls** adds `fix_job_llm_calls (job_id, calls, created_at)`.
  - The worker passes the pg-boss job id to `runFixJob`. pg-boss keeps a job's id across its retries and expiry, so they share one budget, and every new fix job (a push, a dashboard tick, lifting a pause, the fan-out) has its own 20 calls.
  - Each call is counted with an upsert on the job id; counts older than two days (far past a job's retries) are dropped. Without a job id, the budget is counted in memory.
  - `scans.llm_calls` is no longer used. It stays while older machines of a rolling deploy may still write it.
  - Docs: site/security.md and site/guide/fixes.md say a fix job makes at most 20 Claude calls, and retries of the same job share them.
- **#2:** for an organization, a repository counts toward the admin check when it existed at sign-in or GitHub listed it in the session's access for that installation. Admin still needs at least one such repository, and admin on all of them.
- **#3:** `addedSinceSignIn` is the count for account admins only (their next sign-in shows those repositories) and 0 for everyone else, so members see no notice and no count. Docs: site/guide/github-app.md.
- **#4:** `testCounts` in @shapi/repair takes vitest's own summary line: a whole line of counts only (`Tests  1 failed | 2 passed (3)`), the last one in the output. The PR body and the web app's repair summary use it, so nothing else from the output reaches the cell.
- **#5:** each re-match locks the repository row and saves the findings, and sends the notice, under the repository's current account, as the scan job does. A repository deleted meanwhile is skipped.
- **#6:** the rule is "pushes are taken in the order GitHub received them". `handlePush` compares the payload's `repository.pushed_at` (when that push was made; Unix seconds, an ISO string is accepted too) with the newest push already taken for the repository, `repositories.last_pushed_at` (migration 0015). An older push is ignored ("ignored: older than a push already taken"), since the newer push's commit is the branch's head. The row is locked by `upsertRepository`, so pushes of one repository are decided one at a time. A payload without `pushed_at` is taken as before. Commit timestamps are not used: a rebased or cherry-picked commit keeps an old date. Docs: site/guide/github-app.md.
- **Minor items:**
  - **Runtime model:** when an advisory's body trigger lists values and the call sends that field from a variable, or does not send it while the pattern's `{?}` segment says the path carries it at runtime, the matcher puts the call in **possible** ("SHAPI cannot tell the model (affected if it is …)"). This also applies to OpenAI-style model sunsets with a model variable. Docs: site/guide/how-it-works.md and quickstart.md.
  - **run-ts.mjs:**
    - On a Node that strips types by default (22.18+, 23.6+), the script is imported into the wrapper's own process. Its exit code, signals and a stop are those of `node <file.ts>`, and there is no extra process left behind.
    - On 22.14–22.17 it runs in a child. SIGTERM, SIGHUP and SIGBREAK sent to the wrapper are passed on, and Ctrl-C (which the whole terminal or console gets) is left to the script. The wrapper exits with the child's code, or dies of the same signal (128+n).
    - `dev.ts` and `preview.ts` also stop Postgres on SIGHUP (terminal closed) and SIGBREAK (Ctrl-Break on Windows).
  - **Lock timeout:** 0014 is not edited, since it may already be applied in production. Instead the migration runner wraps every migration with `withLockTimeout`, which sets `lock_timeout = 10s` for the migration's transaction. An ALTER queued behind a long transaction then fails the deploy instead of holding up every query on that table.
  - **Test Postgres:** the start limit comes from `SHAPI_TEST_PG_START_TIMEOUT_MS`. The 30 s default stays: CI runs on Linux, where a start takes seconds, and three attempts must fit in the test files' 120 s `beforeAll`. A slow, cold Windows machine can raise it.
  - **Dashboard:** a "Needs you" row whose retry box was ticked while the branch still had the maintainer's commits says "You ticked this, but the branch still has those commits, so nothing was opened."

Not changed: a hard kill of only an ancestor process (pnpm, from Task Manager) on Windows still leaves the script and its Postgres running, since Windows does not end child processes with their parent. Ctrl-C, a tree kill ("End process tree", `taskkill /T`) and a stop of the script's own process do stop it. Node 26 was not run here (only 24.12 is installed); CI's npm-package matrix runs the wrapper on each version.

## Verified

Each test below failed before its change and passes after it.

- **#1:** apps/server/test/cloud.test.ts, "LLM budget: is kept per fix job…": with a budget of 1, a second run of job-1 asks Claude nothing, and job-2 on the same scan gets its own call.
- **#2:** apps/server/test/web.test.ts, "first run: an organization admin who signs in before the installation webhook creates the repositories…": sign in, then `processDelivery` of the installation webhook stores the repositories, then Settings answers 200 with no notice.
- **#3:** web.test.ts, "tells only account admins that repositories were added since sign-in…": a member with read on one repository sees no notice on the overview, repositories and problems pages after two repositories are added. The admin's notice tests (web.test.ts, billing.test.ts) still pass.
- **#4:** packages/github-app/test/body.test.ts, "takes the test counts from vitest's own summary line…": a look-alike line holding a link and a mention before the real summary gives `fail (1 failed)` and `pass (1 passed)`.
- **#5:** cloud.test.ts, "saves a re-match under the account the repository is in now…": the second repository is transferred while the fan-out works on the first, and its findings and notice go to the new account.
- **#6:** apps/server/test/github.test.ts, "a push older than one already taken (delivered late) queues no scan…": push B, then an older push A is ignored, and newer pushes (an ISO `pushed_at`, or none) are taken.
- **Minor items:**
  - packages/extractor/test/advisory-matching.test.ts: the REST Gemini call with a runtime model and an SDK call with a model variable are possible for all three `-sdk` shutdowns. packages/extractor/test/body.test.ts: a model from a variable is possible, with the reason.
  - apps/server/test/run-ts.test.ts, in both modes (in this process, and in a child via `--no-experimental-strip-types`): arguments and exit code 7 are passed on; one process only when types are stripped by default. The signal tests run on Linux (CI) and are skipped on Windows. By hand on Windows: the preview started through the wrapper is one `node` process with Postgres beneath it, and a tree kill leaves nothing running.
  - packages/db/test/db.test.ts: a wrapped migration sees `lock_timeout` 10s in its transaction only, and an ALTER behind a held lock fails with a lock timeout. The migration list includes 0015.
  - packages/db/test/test-postgres.test.ts, "takes its start time limit from SHAPI_TEST_PG_START_TIMEOUT_MS…".
  - apps/server/test/fixes.test.ts, "a fix whose branch has a maintainer's commits…": the ticked row explains why nothing was opened.
- **Checks:** `pnpm typecheck` and `pnpm lint` pass. The touched and covering test files pass: apps/server, packages/db, core, extractor, github-app, repair, cli, mcp and site, 46 files and 433 tests (4 skipped on Windows). CI runs the full suite.
