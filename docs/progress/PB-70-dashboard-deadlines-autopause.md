# PB-70: Open PRs grouped by deadline, and a pause after three closed PRs (execution plan U-05)

## Why

- **Deadlines.** The Dashboard issue listed open fix PRs alphabetically. The question a maintainer has is which ones are urgent.
- **Unwanted PRs.** A repository that keeps closing SHAPI's PRs is telling SHAPI something. It should stop opening them on its own rather than wait to be uninstalled.

## What changes

- **Grouping.** "Open fix PRs" on the Dashboard issue is split into **Already in effect**, **In the next 30 days** and **Later**, ordered by the advisory's effective date. Each row says when its change takes or took effect ("takes effect 2026-11-12, in 13 days").
- **Automatic pause.**
  - When a SHAPI PR is closed without merging and the repository's last three finished SHAPI PRs (merged or closed) were all closed unmerged, the pull_request webhook pauses the repository.
  - It records `autoPaused` (when, and which PRs) and queues a fix job right away, so the dashboard is redrawn without waiting for a push.
  - The pause holds even before the issue is redrawn, since the issue's checkboxes are otherwise the source of truth.
- **The dashboard says why:** the pause box is ticked, with "SHAPI paused itself on …: its last 3 fix PRs (#…) were closed without merging … Untick the box above to resume."
- **Resume.** Unticking clears `autoPaused` and records `resumedAt`. Only PRs finished after that count toward the next pause, so one more close doesn't immediately pause again.
- **Web app.** The repository page tags it "paused by SHAPI" and says why.
- **Docs.** The GitHub App guide describes both.

## Verified

- **Server test** (`apps/server/test/fixes.test.ts`):
  - three PRs are closed by webhook; the third pauses the repository and queues a dashboard redraw;
  - the next run opens nothing, and the dashboard shows the ticked box and the reason with the PR numbers;
  - unticking resumes, the next fix opens, and one more close doesn't pause.
- **Grouping test:** three open PRs with past, 13-day and far-off deadlines land under the three headings in that order, with their dates.
- **Web test:** the repository page shows "paused by SHAPI" and why, and not after a resume.
- **Existing tests:** the earlier dashboard, pause and webhook tests still pass. So do the github-app and cloud suites, typecheck and lint.
