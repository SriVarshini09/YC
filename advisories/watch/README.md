# Watched provider pages

`sources.json` lists the provider pages advisories come from (deprecation pages, changelogs), and `snapshots/` holds each page's text as last seen. `pnpm canary watch` checks them:

- **A page that changed** gets a draft in `advisories/drafts/watch/` listing the lines added and removed, and its snapshot is updated. A person reads the draft and writes or updates an advisory if it announces an API change.
- **A page that fails a fetch guard** gets one issue (`--issues <file>` writes them as JSON), keeps its snapshot, and gets no draft. The guards:
  - anything but 200, and any redirect;
  - fewer than `minBytes` or more than `maxBytes`;
  - a missing `marker` (text the page must contain);
  - losing more than 40% of its text since the snapshot.

The run exits 1 when any source failed, so a scheduled run shows up as failing.
