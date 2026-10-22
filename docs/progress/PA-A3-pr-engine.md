# PA-A3 PR engine

What exists: the PR engine, modeled on how Renovate and Dependabot keep noise down.
- `upsertFixPr` keys each fix to its branch `shapi/<advisory>`. A rerun with the same fix changes nothing; a changed fix, or a PR that conflicts with its base, is regenerated on the current base and force-pushed. The `shapi fix --pr` CLI uses the same path.
- It never overwrites a branch someone else pushed to (each SHAPI commit carries a `SHAPI-Branch` trailer) or a PR labeled `shapi:stop`.
- A PR closed without merging stays closed. A merged fix frees the branch.
- `planFixPrs` opens the most urgent fixes first, up to 2 new PRs per hour and 10 open (both configurable per account). The rest wait.
- Each repo gets one "SHAPI Dashboard" issue: open PRs, waiting fixes ("open now" boxes), closed fixes ("open again" boxes), manual fixes, deadlines, and a pause box.
- `deliverRepoFixes` applies the policy, records every PR in the new per-tenant `fix_prs` table, and refreshes the dashboard; it is idempotent.
- Webhooks keep the records current: `pull_request` (closed, merged, reopened, stop label) and `issues` (dashboard ticks; bot edits ignored).
- GitHub clients now throttle writes and retry rate limits and 5xx errors (Octokit throttling and retry plugins).

Verified: 180 tests pass, 18 of them new. They run against an in-memory GitHub and real Postgres, covering limits, ordering, idempotent reruns, conflicts, edited branches, the stop label, closed and merged PRs, dashboard ticks, pause, and tenant isolation of `fix_prs`. In a live check on 2026-10-22 on `shapi-demo` with an hourly limit of 1: PR #3 opened (labeled, with the trailer) while B waited and dashboard issue #4 was created; a rerun changed nothing; ticking B on the dashboard arrived by webhook and the next run opened PR #5; merging #3 and #5 was recorded as merged and queued scans of main.
Not done: the scan and repair jobs that produce fixes to deliver (A5), which must run one delivery per repository at a time. A dashboard tick is saved at once but acted on at the next delivery run. Closing without merging was tested only in the automated tests. GitHub warns that the default REST API version retires in March 2028.

```
pnpm test
pnpm build && pnpm --filter @shapi/server dev    # needs the app's Issues event enabled
```
