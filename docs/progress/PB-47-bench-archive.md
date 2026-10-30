# PB-47: Every benchmark instance is mirrored in Software Heritage (execution plan P-07)

## Why

APIBreak-Replay depends on 71 public repositories that SHAPI doesn't own. When an owner deletes a repository or force-pushes a branch, its instance can't be scanned any more. One already can't: voilalz/frontier-pulse's fix commit returns 404. A public benchmark has to outlive its sources.

## What changes

- **Archive.** [Software Heritage](https://archive.softwareheritage.org) is the public archive of source code used for research reproducibility. A git commit's permanent identifier there is its SHA (`swh:1:rev:<sha>`). Nothing is copied into SHAPI's repositories or accounts.
- **`src/swh.ts`:**
  - `mirrorUrl()` builds a commit's page.
  - `swhHasCommit()` asks whether Software Heritage holds the commit.
  - `swhTarball()` asks the vault to prepare the commit's files and downloads them.
- **Fallback.** `scanCommit({ mirror: true })` falls back to Software Heritage when GitHub answers 404. `bench:run` turns it on, so a deleted repository still scores.
- **`bench:archive`.** It checks every instance's fix commit; the base commit, its parent, comes with it. It writes `datasets/apibreak-v0.mirrors.json`, which holds each instance's mirror URL and whether it is archived. With `--save`, it first sends "Save Code Now" requests for the repositories Software Heritage doesn't hold. The file is kept apart from the dataset, so the dataset hash and the CI baseline stay the same.
- **Save requests.** On 2026-10-30, with the founder's go-ahead, I sent save requests for all 71 repositories, within Software Heritage's anonymous rate limit.

## Status

- **2026-10-30:** 13 of 71 instances archived when this PR was opened. The rest are queued at Software Heritage.
- **Next:** a follow-up run of `bench:archive` records the rest. P-07 is ticked when every instance is archived.

## Verified

- **Tests:**
  - the mirror URL format;
  - the archive check, for a commit it holds and one it doesn't;
  - vault preparation and download (it waits for the archive to be ready);
  - a commit GitHub deleted is scanned from its Software Heritage copy and still flagged, and fails without the mirror;
  - the mirror file lists every instance, in dataset order, with its URL.
- **Full suite:** typecheck, lint and the full test suite.
