# PA-A3 PR engine

What exists: the PR engine, modeled on how Renovate and Dependabot keep noise down.
- `upsertFixPr` keys each fix to its branch `shapi/<advisory>`. A rerun with the same fix changes nothing; a changed fix is regenerated on the current base and force-pushed.
- It never overwrites a branch someone else pushed to (each SHAPI commit carries a `SHAPI-Branch` trailer) or a PR labeled `shapi:stop`.
- A PR closed without merging stays closed. A merged fix frees the branch.
- `planFixPrs` opens the most urgent fixes first, up to 2 new PRs per hour and 10 open (both configurable per account). The rest wait.
- Each repo gets one "SHAPI Dashboard" issue: open PRs, waiting fixes ("open now" boxes), closed fixes ("open again" boxes), manual fixes, deadlines, and a pause box.
- `deliverRepoFixes` applies the policy, records every PR in the new per-tenant `fix_prs` table, and refreshes the dashboard; it is idempotent.
- Webhooks keep the records current: `pull_request` (closed, merged, reopened, stop label) and `issues` (dashboard ticks; bot edits ignored).
- GitHub clients now throttle writes and retry rate limits and 5xx errors (Octokit throttling and retry plugins).

Verified: 178 tests pass, 16 of them new. They run against an in-memory GitHub (git refs, commits, trees, PRs, issues) and real Postgres, covering caps, ordering, idempotent reruns, edited branches, the stop label, closed and merged PRs, dashboard ticks, pause, and tenant isolation of `fix_prs`.
Not done: the scan and repair jobs that produce fixes to deliver (A5). A dashboard tick is saved at once but acted on at the next delivery run.

```
pnpm test
pnpm build && pnpm --filter @shapi/server dev    # needs the app's Issues event enabled
```
