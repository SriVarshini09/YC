# PB-29: Server follow-ups to the full review

## Why

Six things the full review's fixes left open:

- The production snapshot path (`parseTarball` in packages/github-app) still dropped any file over 5 MB, lockfiles included. packages/sandbox had already been fixed with `SNAPSHOT_KEEP`; without the lockfile the sandbox install picks the wrong package manager.
- The fix job undid each advisory's repair with `ws.write(file, before)`. A file the repair created (every contract test, and any new module from Claude) has `before: ""`, so it stayed in the workspace as an empty file. A rejected site's source edits were not undone at all when no site of that advisory was fixed.
- `renderPrBody` put Claude's explanation into the PR body as Markdown. Model output could add links, images, HTML, `@mentions` (which notify people) or new headings. The body also didn't show the type-check result added to `RepairResult.typecheck`.
- `@shapi/core`, `db`, `extractor`, `repair`, `sandbox` and `shapes` were not `"private": true`, so a `pnpm publish -r` would publish them. Only `shapi-cli` (built by packages/cli/scripts/build-npm.ts, which writes its own package.json) is published.
- A fix whose branch has a maintainer's commits was listed under "Waiting" with a "Tick to open it now" box. Ticking it could never help, because SHAPI no longer force-pushes over foreign branches.
- test-utils/postgres.ts:
  - (a) Teardown failed passing test files with EBUSY. The cause: with `persistent: false`, embedded-postgres's own `stop()` removes the data folder with no retries, and it rejects before our retrying `removeDir` ran.
  - (b) Starts could stall. A failed start called embedded-postgres `stop()` on a server that had already exited, which waits for an exit event that never comes (so the retry never happened, and its exit hook waits the same way). Nothing limited how long a start could take. With `listen_addresses` left at localhost, a port another server held on 127.0.0.1 still started on ::1, so the tests could talk to the other server.

## What changes

- `parseTarball` keeps files in `SNAPSHOT_KEEP` (package.json and lockfiles) whatever their size.
- apps/server/src/jobs/fix.ts: after each advisory, every file any site touched, plus every site's contract test, is reset from the snapshot. A file in the snapshot gets its original text back, and any other file is removed with `Workspace.remove`.
- `renderPrBody`: Claude's explanations are shown as an inline code span (`codeSpan`: one line, at most 500 characters, fenced longer than any backtick run in it). GitHub renders that literally: no links, images, mentions, issue references or HTML. Recipe notes are unchanged. The contract-test table has a "Type check" column, for example ``pass: `tsc --noEmit -p tsconfig.json: no new errors` ``. Docs: site/guide/fixes.md.
- `"private": true` in the six package.json files. build-npm.ts builds the published package.json from scratch and copies no `private` field.
- `upsertFixPr` marks a skip caused by a foreign branch with `foreignBranch: true`. The dashboard gets a "Needs you" section for those fixes: "Delete the branch and SHAPI opens the fix on its next scan". For a closed PR that was retried, the row says "delete the branch, then tick to open the fix again" and keeps the retry box. Such a fix is not listed under "Waiting" or "Closed without merging". Docs: site/guide/github-app.md.
- test-utils/postgres.ts:
  - `persistent: true`, so only our retrying `removeDir` removes the folder, and `stop()` never throws.
  - `kill()` forgets a server that already exited, and kills outright one that doesn't exit within 10 s.
  - Each start has a time limit (30 s by default). A failed or timed-out start is killed, along with anything it was still starting, and retried on a new port. After the last attempt the error names every attempt's port, reason and last log lines.
  - The server listens on 127.0.0.1 only, and the ready line is detected across output chunks.
  - New options (`attempts`, `timeoutMs`, `port`) exist for tests.

## Verified

- `packages/github-app/test/snapshot.test.ts`: an oversized pnpm-lock.yaml is kept. This failed before the change.
- `apps/server/test/cloud.test.ts`, "repairs all three demo findings…": the workspace has no changed files and no contract tests left after the job. This failed before the change.
- `packages/github-app/test/body.test.ts` (new): the explanation is literal text, a long explanation is cut, a backtick run can't close the code span, and the type-check column is shown. All three tests failed before the change.
- `packages/cli/test/cli.test.ts`, "publishes only shapi-cli…": every workspace package is private. This failed before the change.
- `apps/server/test/fixes.test.ts`, "a fix whose branch has a maintainer's commits needs them…". This failed before the change.
- `packages/db/test/test-postgres.test.ts` (new): a busy port fails fast and is retried, a start over its time limit is killed with a clear error, and `stop()` resolves while a process holds the data folder. On the old harness all three failed, and the last one with the same EBUSY seen in fixes.test.ts teardown.
- `pnpm typecheck` and `pnpm lint` pass. The touched and covering test files pass: github-app, db, apps/server cloud/fixes/github, cli cli/fix, and site (127 tests). CI runs the full suite.
