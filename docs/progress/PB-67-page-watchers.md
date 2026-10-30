# PB-67: Page watchers behind fetch guards (execution plan C-01)

## Why

Advisories come from provider pages: deprecation lists, changelogs. Watching them is how SHAPI hears about a change before anyone's code breaks. But a fetch that returns a 404, a login wall, a consent redirect or half a page would look like the provider deleting its notes. A watcher has to tell a page that changed from a page it couldn't read.

## What changes

- **`pnpm canary watch`** (`packages/canary/src/watch.ts`) fetches each page in `advisories/watch/sources.json` and compares its visible text with the committed snapshot in `advisories/watch/snapshots/`.
- **The fetch guards.** A page is rejected for:
  - any status but 200;
  - any redirect (`redirect: "manual"`);
  - fewer than `minBytes` (2,000 by default) or more than `maxBytes` (5 MB);
  - a missing marker;
  - losing more than 40% of its text since the snapshot.
- **A rejected page** gets one issue per source (`--issues <file>` writes them as JSON), keeps its snapshot, and gets no draft. The run exits 1.
- **A changed page** gets a draft in `advisories/drafts/watch/` listing the lines added and removed, and its snapshot is updated.
- **Sources:** OpenAI's deprecations page, Anthropic's model deprecations, GitHub's REST breaking changes, Stripe's changelog and Gemini's deprecations, each with markers. Their first snapshots are committed.
- **`pageText()`** keeps only the visible text, one line per block, so scripts, styles and re-renders don't count as changes.
- **Found while building it:** Gemini's page redirected to a Spanish-locale version on a second fetch. The redirect guard rejected it instead of recording a change, and the source is now pinned to `?hl=en`.

Running it on a schedule, and turning the issues into GitHub issues, needs a workflow the founder approves. Both would act on the repository on their own.

## Verified

- **Unit tests** (`packages/canary/test/watch.test.ts`):
  - a 404 opens an issue, not a draft, and keeps the snapshot (the C-01 test);
  - redirects, too small, too large, a missing marker, a fetch error;
  - a 50% shrink rejected while a smaller trim counts as a change;
  - first, unchanged (scripts don't count) and changed with a draft;
  - one issue per failing source while the others run;
  - the bundled sources validate and have snapshots.
- **Real runs:** five pages snapshotted, then a second run reads all five as unchanged.
- **Checks:** typecheck, lint and the canary tests pass. CI runs the full suite.
