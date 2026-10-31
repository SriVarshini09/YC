# PB-89: Nightly advisory drafts (execution plan C-01, C-04)

## Why

C-04's models.dev ingest and C-01's guarded page watchers existed as commands, but nothing ran them. The founder approved nightly runs on 2026-10-30.

## What changes

- **`.github/workflows/nightly.yml`** runs every night at 06:17 UTC, or by hand:
  - `pnpm canary models-dev` drafts a `version-sunset` advisory for every model models.dev marks deprecated on a host SHAPI knows. A draft from an earlier night keeps the day the model was first seen deprecated.
  - `pnpm canary watch` fetches the watched provider pages through the C-01 fetch guards and compares each with its committed snapshot.
- **New drafts and updated snapshots** are pushed to the `nightly/advisory-drafts` branch, with one open issue, "Nightly advisory drafts to review". Each night with changes adds a comment linking the comparison with `main`.
  - A pull request would be nicer, but the repository doesn't let GitHub Actions open pull requests. That's a repository setting, left as it is.
- **A watched page that fails its guards** gets its own issue, one per page and never a duplicate while it's open.
- **Nothing is merged or published from here.** Drafts are `unverified` until a person reviews them (C-03), and unverified advisories never open fix PRs.
- **Permissions:** `contents: write` (the review branch only) and `issues: write`. The actions are pinned to release tags, as CI requires.

## Verified

- **Both commands run locally** as the workflow calls them:
  - `models-dev` drafted 14 deprecated models (OpenAI's o3-mini and o4-mini among them);
  - `watch` checked 5 pages, all passing their guards, with none changed.
- **The schedule** takes effect once this is on `main`. The first run can be started by hand from the Actions tab (workflow_dispatch).
