# Fix delivery in repositories with Issues turned off

## Why

The launch smoke test (2026-10-30) found this in the live logs. The `repo-fix` job for SriVarshini09/Nori, a public repository with Issues turned off, was dead-lettered after 3 attempts with `dashboard: Issues has been disabled in this repository`.

SHAPI keeps a dashboard issue per repository. When creating it failed, the whole delivery failed. The job then retried, re-running the PR step each time, and gave up, on every push to that repository.

## What changes

- `deliverRepoFixes` (`apps/server/src/github/fixes.ts`) treats GitHub's 410 "Issues has been disabled" as no dashboard, not as an error.
  - The report says `noDashboard: "issues-disabled"`.
  - The fix PRs are delivered and the job succeeds.
- Any other dashboard error still fails the job, as before.

## Verified

- New test with a fake repository that answers 410 on issue creation: both fix PRs open, the report has no errors, and no issue exists.
- The other fix delivery tests pass.

## Not done

- Without the dashboard, a maintainer in such a repository can't tick "open now" or "retry" there. The web app's controls still work. The guide doesn't say this yet.
