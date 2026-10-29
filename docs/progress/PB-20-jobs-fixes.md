# PB-20: jobs, webhooks and database fixes from the full review

## Why

The full review (reviewer 2: jobs, GitHub events, queue, db; plus one finding each from reviewers 1 and 5) found ways for background work to get stuck, lost or undone: scans left `running` for good, fix jobs on an older scan than the newest, a fix job undoing a pause from the web app and erasing dashboard ticks, Slack alerts rejected for length, and several smaller gaps in the webhook sweeper, the queues and the database client.

## What changes

- **Stuck scans (M2).** `staleQueuedScans` puts a scan back to `queued` once it has been `running` for 30 minutes (longer than a scan job may run), so the sweeper re-sends it. Before, a worker that died mid-scan left the scan running forever, and the retried job skipped it.
- **Fix jobs use the latest scan (M3, queue part).** The `repo-fix` queue keeps one waiting job per repository and drops later ones. `runFixJob` now fixes the repository's latest successful scan, not the possibly older scan its job names. (The PR commit on a moved base branch is the github-app fixer's.)
- **No more stale settings writes (M4, review-1 medium).** The fix job and the dashboard webhook write only their own keys of `repositories.settings` (`settings || {...}`), so a pause set from the web app while a job runs is kept.
- **Dashboard ticks during a run (L15, review-5 L10).** `upsertDashboard` takes the boxes the body was rendered from. A box a maintainer ticked on the issue meanwhile (or the pause box they toggled) is carried into the new body and into settings, so the next job acts on it.
- **Slack alerts fit (M5).** The findings section stops before Slack's 3000-character limit and counts the rest ("…and N more."). File paths in links are URL-encoded, and advisory links use `blob/HEAD`.
- **Webhooks:**
  - The sweeper does not queue a delivery again while a job for it still waits (L1). The queue's standard policy ignores `singletonKey`.
  - One redelivery GitHub refuses no longer stops the sweep, and lost scans are re-queued before the webhook sweep (L4). Failures are counted in `redeliveryFailed` and logged as an error.
  - The scans and fix jobs a delivery asks for are stored with it (`webhook_deliveries.jobs`) until the worker has queued them (L5). A retry after a failed send gets them again, and the sweeper re-queues such deliveries.
  - Deliveries that failed after the job's retries (for example during a GitHub outage) are retried once an hour for a day after they arrived (L13: retrying is right, since an `installation` event lost to an outage was lost for good). `errored_at` records the last failure.
  - A payload with a NUL character is stored with U+FFFD instead (jsonb refuses `\u0000`).
- **Repositories:**
  - A resync updates `enabled` from GitHub's `archived` flag. A `repository` archived or unarchived event does the same, and unarchiving queues a scan (L2).
  - A repository moved to another installed account takes its scans, findings and fix PRs along (L10).
- **One pending scan per commit (L9).** `scans_pending` is now a unique index (migration 0013 first marks existing duplicates failed). Push handling and first scans insert with `on conflict do nothing`.
- **Advisory sync:**
  - The folder sync removes advisories deleted from the folder (L6).
  - The repository sync reads the repository's default branch instead of `main` (L7).
- **Queues (L8).** `createQueues` applies each queue's options with `updateQueue`, and fails loudly when a queue's stored policy differs from the code.
- **Database client (L11).** The app role is set in pg's awaited `onConnect` hook. A connection that cannot switch role fails the query instead of running as the connecting user, and no unhandled rejection is raised.
- **Sentry (L3).** Request breadcrumbs to `hooks.slack.com` are dropped, and other breadcrumb URLs lose their query string.
- **Minor:**
  - `scansToRefix` skips repositories the plan does not cover. Before, each deploy created a failed "not covered" scan for them.
  - The app role loses its grant on `kysely_migration` and `kysely_migration_lock`.
  - The `removeAdvisoriesNotIn` doc comment now says it returns the removed ids.

Migration `0013_jobs_fixes` adds `webhook_deliveries.jobs` and `errored_at`, makes `scans_pending` unique, and revokes the migration-table grants.

## Verified

- `apps/server/test/cloud.test.ts`:
  - a dead worker's running scan is re-queued and then runs, and a recent one is left alone;
  - one pending scan per commit, even when two inserts race;
  - a fix job for an older scan fixes the latest one, and its PR keeps the newer commit;
  - `scansToRefix` skips uncovered repositories;
  - Slack sections stay at or under 3000 characters with the right count, and paths are encoded.
- `apps/server/test/fixes.test.ts`: a web-app pause and an issue tick made while the job opens PRs both survive.
- `apps/server/test/github.test.ts`:
  - stored jobs are returned until they are queued;
  - archive and unarchive, from a resync and from the repository event;
  - a transfer moves the child rows;
  - the sweeper retries failed deliveries hourly and re-queues deliveries with unqueued jobs;
  - a refused redelivery does not stop the sweep;
  - a NUL payload is stored;
  - queue options are applied, a changed policy is refused, and a waiting delivery is not queued twice.
- `apps/server/test/advisory-sync.test.ts`: a default branch named `trunk`, and folder removal.
- `apps/server/test/server.test.ts`: breadcrumb scrubbing.
- `packages/db/test/db.test.ts`: the migration-table grant is gone, and a role that cannot be set fails closed.
- `packages/github-app/test/engine.test.ts`: `upsertDashboard` carries new ticks and the pause box.
- Each new test fails with the old source file put back.
- Typecheck, lint and the full suite (313 tests) pass.
