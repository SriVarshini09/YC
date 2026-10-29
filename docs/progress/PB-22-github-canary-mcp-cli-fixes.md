# PB-22: fix PRs that can't revert newer commits, quieter canaries, safer CLI and MCP

## Why

Review 5 (GitHub App, canary, MCP, CLI) found a fix PR that could silently revert work: it wrote whole files on top of the base branch's head at delivery time, while the fix had been computed from an older commit or from a local checkout. It also found canary probes that file critical drafts from rate limits and from a busy repo's newest run, and several smaller CLI and MCP defects.

## What changes

- **Fix PRs never revert newer commits (H1).**
  - The server's fix job passes the scanned sha, and `upsertFixPr` builds the fix commit on it. A push to main after the scan is merged by GitHub as usual, or shows as a conflict.
  - `shapi fix --repo … --pr` builds on the cloned commit.
  - From a local checkout, each changed file must match the one on the base branch, or the PR is refused and the error names the file. So the PR can't revert upstream commits or publish local edits.
  - A conflicting PR that already sits on the scanned commit is left alone, since rebuilding it would recreate the same conflict.
- **Maintainers' commits are kept (M1, L1).**
  - SHAPI's commits now carry a `SHAPI-Tree` trailer. An amended or squashed commit that kept `SHAPI-Branch` has a different tree, so it no longer counts as SHAPI's.
  - Retrying a closed fix, or reusing a merged fix's branch, never force-pushes over someone else's commits.
- **Files are read through the tree and blob APIs (L2, L3).**
  - The executable bit is kept.
  - Files over 1 MB are compared in full and keep CRLF line endings.
  - No recursive tree listing, which GitHub truncates in big repositories.
- **Snapshots stream (M2).** The tarball is unpacked as it downloads, and the download stops as soon as a limit is hit. Before, the whole archive was buffered first.
- **Canary (M3, M4, M5).**
  - The following are probe errors and are not recorded:
    - a 429;
    - a 403 with `x-ratelimit-remaining: 0` or `retry-after`;
    - a 401 on a probe that sends SHAPI's own key.
  - `github:list-runs` now lists the newest successful push run on main of one workflow (actions/checkout `test.yml`), with PRs excluded. On 2026-10-29, 25 of the 29 newest runs of the whole repo differed in shape from the newest one, while the 10 newest runs of the pinned query all had the same shape.
  - A malformed credential fails only its own provider (`<provider>:config`).
  - `run --interval` survives a failed run.
  - On SIGINT, the store closes only after a run in progress has finished.
  - `--provider <typo>` is an error.
- **CLI (L4–L8, L12, L13).**
  - An unknown `--advisory` is an error (exit 2).
  - `--write` with `--repo` is refused.
  - All checks run before cloning, and a failed clone leaves no temp folder.
  - Credentials in `--repo` URLs are removed from output and errors.
  - The `--repo` "Next" hint is a command you can run as printed.
  - The canary store is used only when it saw the advisory's kind of change.
  - The README describes the dry run as it is: it lists the files.
- **MCP (L11, L5).**
  - `path` arguments outside the project are refused. `SHAPI_MCP_ANY_PATH=1` allows them.
  - `scan` is marked open-world.
  - `scan` returns `possible` findings.
  - `apply_fix` with an unknown advisory is an error.
- **Smaller fixes.**
  - `authFromEnv` reads the App key only when the App is configured, and an empty `GITHUB_TOKEN` falls through to `GH_TOKEN`.
  - The unused `openFixPr` is removed.
  - A `|` in a table cell is escaped. Before this, vitest's `1 failed | 1 passed` added a column to every PR's contract-test table.
  - A webhook whose original attempt has aged out of the listed window is not redelivered again.
  - `cli`, `mcp`, `canary` and `github-app` are marked `"private": true`.
  - `build-npm` uses `node:module`'s `isBuiltin`.

Docs updated: `site/guide/fixes.md`, `site/guide/cli.md`, `site/guide/agents.md`, `docs/agents.md`, `README.md` and `packages/cli/README.npm.md`.

## Verified

- New tests:
  - `test-utils/fake-github.ts` (main moves after the scan; the PR's parent is the scanned commit, and main keeps its change);
  - `engine.test.ts`, `cloud.test.ts`, `snapshot.test.ts` and `app.test.ts`;
  - `canary.test.ts`, `cli.test.ts`, `fix.test.ts` and `server.test.ts`.
- Each new test failed on the old code.
- Typecheck and lint are clean. Tests: 43 files, 320 tests, all passing. Under load from parallel runs, `apps/server/test/fixes.test.ts` sometimes fails in teardown (EBUSY removing the embedded Postgres folder); it passes on a re-run.
