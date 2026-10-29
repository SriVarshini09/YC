# PB-32: Server fixes from review 7

## Why

Review 7 read the nine combined fix PRs (#69–#77) together. These are its server, GitHub App and repair findings:

- **#2:** the repo-fix queue expired jobs at 30 minutes, while one fix job's sandbox may now run 60 (`MAX_SANDBOX_LIFETIME_MS`). pg-boss then retried a job that was still delivering PRs. Past 53 minutes, any test or `tsc` run threw the lifetime error, which nothing caught on the recipe path: the whole job failed, and the fixes it had already verified were never delivered, on every retry.
- **#3:** the `repository` webhook handler (archived and unarchived) could never run, because the App did not subscribe to the event.
- **#4:** access is read from GitHub at sign-in. A repository added to the installation afterwards was in nobody's session, so an organization admin lost Settings and Billing (403) for up to 8 hours. The new repository was also hidden without a word, and Billing counted it in "N not covered" but left it out of its list.
- **#6:** a corrupt tarball download rejected a promise nothing handled yet, which ends the process when Sentry is not configured.
- **#9:** the fix job's "latest scan" was the last to finish, not the newest queued as on the web. A retried scan of an older commit replaced the newer commit's fix PRs.
- **#10:** a scan claimed before its repository was transferred saved its findings under the old account, so row-level security hid them from the new owner.
- **#11:** the LLM budget comment said retries could not run up the bill, but each attempt of a fix job made its own budget.
- **Minor items:**
  - `pnpm pack:cli` and the other `node <file>.ts` scripts failed on Node 22.14–22.17, which `engines` allows.
  - `repairAdvisory`/`repairCallSite` given a `repoDir` left their temp copy, `.env` files included.
  - "Sign out" did nothing when the cookie's session was gone.
- **From PR #80's notes:** recipe notes put the repository's code between single backticks, so code holding a backtick broke out of the span. A call site's failure reason, which can quote test output, went into the PR body raw.

#1 and #5 were already fixed on main by PR #80: the fix job resets every touched file from the snapshot, and `parseTarball` keeps `SNAPSHOT_KEEP` files whatever their size.

## What changes

- **#2:**
  - `repoFix` `expireInSeconds` is 75 minutes. `createQueues` applies it to the existing queue with `updateQueue`.
  - @shapi/sandbox throws `SandboxLifetimeError`, and repairCallSite's LLM catch rethrows it.
  - The fix job catches it per advisory. It delivers the fixes verified before that, and reports the remaining advisories as `not-attempted`. It doesn't mark the scan's engine, so the next build tries the rest.
- **#3:** `APP_EVENTS` includes `"repository"`, so the manifest's `default_events` has it. Docs: site/guide/github-app.md.
- **#4:**
  - `Session.createdAt` is the session row's `created_at`, in database time like `repositories.created_at`.
  - For an organization, `accountAccess` makes the user an account admin when they are admin on every repository that existed when they signed in, and there is at least one. Repositories added later don't count against them.
  - `addedSinceSignIn` counts the repositories added since sign-in that the user can't see. Every account page then shows: "N repositories were added since you signed in. Sign in again to see them."
  - Billing's "N not covered" counts every repository, like the plan. Its list shows the ones the user can see, plus a "N more repositories you can't see here" row.
  - Docs: site/guide/github-app.md.
- **#6:** `parseTarball` handles the parse promise as soon as it exists. On a parser error it stops reading the download and rejects with that error.
- **#9:** `latestScanId`, `scansToRefix` and the advisory fan-out order by `created_at desc`, as the web pages do.
- **#10:** the scan's write transaction locks the repository row and saves the scan and its findings under the repository's current account. A transfer delivery waits for that lock, then moves the rows as usual.
- **#11:**
  - Migration **0014_scans_llm_calls** adds `scans.llm_calls`.
  - `withCallBudget` takes an optional counter. The fix job counts each call on the scan (`llm_calls + 1 … returning`), so all of a scan's fix job attempts share one budget.
  - The `fixRetry` after a deploy runs a fresh scan, so it still gets one retry per build.
  - Docs: site/guide/fixes.md.
- **Node scripts:** `scripts/run-ts.mjs` runs a `.ts` file, adding `--experimental-strip-types` only when `process.features.typescript` is off. It is used by `pack:cli`, `advisories:pull`, the server's `dev` and `preview`, and CI's npm-package job.
- **Temp copy:** with only a `repoDir`, repairCallSite and repairAdvisory work in a temp copy and remove it when they return.
- **Sign out:** `/logout` clears a cookie that has no session. Ending a real session still needs the form's CSRF token.
- **PR body:**
  - `codeSpan` (and a `swap` helper for "code → code") moves to @shapi/repair. @shapi/github-app re-exports it.
  - The recipes put paths and code in code spans.
  - `renderPrBody` puts the call site's file, endpoint and failure reason in code spans too.
  - Docs: site/guide/fixes.md.

**Founder step:** the live GitHub App was created from the old manifest, and a manifest applies only at creation. In the App's settings, open *Permissions & events*, tick **Repository** under *Subscribe to events*, and save. It needs no new permission, because `metadata: read` covers it. Until then, archiving a repository still leaves SHAPI running on it.

Not changed in #4: a repository transferred in from another installed account keeps its original `created_at`, so it still counts against an organization admin until they sign in again.

## Verified

Each test below failed before its change and passes after it.

- **#2:**
  - apps/server/test/cloud.test.ts, "delivers the fixes verified before the sandbox ran out of time…": the first advisory's PR is opened, the rest are `not-attempted`, and `fix_engine` stays null.
  - apps/server/test/github.test.ts, "applies changed options to an existing queue…": the repo-fix queue's expiry, after an old 30-minute setting, is longer than `MAX_SANDBOX_LIFETIME_MS`.
  - packages/sandbox/test/sandbox.test.ts: the error is a `SandboxLifetimeError`.
- **#3:** packages/github-app/test/app.test.ts, "asks for the minimum permissions and events".
- **#4:**
  - apps/server/test/web.test.ts, "keeps an admin's rights when a repository is added after sign-in…".
  - apps/server/test/billing.test.ts, "a private repository added after sign-in…": a 200 page, "3 not covered", and the notices.
- **#6:** packages/github-app/test/snapshot.test.ts, "rejects a corrupt download without an unhandled rejection…".
- **#9:** cloud.test.ts, "the latest scan is the newest queued, not the last to finish…".
- **#10:** cloud.test.ts, "a repository transferred to another account while its scan runs…".
- **#11:**
  - cloud.test.ts, "LLM budget: is kept on the scan…": with a budget of 1, a second run of the job asks Claude nothing.
  - packages/repair/test/agent.test.ts, "shares one budget between runs…".
  - packages/db/test/db.test.ts: the migration list includes 0014.
- **Node scripts:** `pnpm pack:cli` passes on Node 24. `node --no-experimental-strip-types scripts/run-ts.mjs x.ts` runs a typed script through the flag branch.
- **Temp copy:** agent.test.ts, "with only a repoDir, removes its temp copy…".
- **Sign out:** web.test.ts, "signs out only on a form from this site": the dead cookie is cleared.
- **PR body:** packages/github-app/test/body.test.ts, "keeps the repository's code, paths and test output literal…". The note expectations in recipe.test.ts, apply-fix.test.ts and packages/cli/test/fix.test.ts are updated to the code-span form.
- **Checks:** `pnpm typecheck` and `pnpm lint` pass. The touched and covering test files pass: apps/server, packages/db, sandbox, repair, github-app, cli and site, 29 files and 309 tests. CI runs the full suite.
