# Advisory evidence

`captures.json` holds the Wayback Machine's earliest capture (HTTP 200) of every advisory source, so an advisory's evidence survives a provider editing or deleting its page. A source with no capture says so in a `note`.

It is written by `pnpm --filter @shapi/bench bench:wayback`, which reads the archive's public CDX API and never asks it to save a page. A capture once found is kept; sources without one are looked up again on the next run.

`loadAdvisories` skips this folder, like `drafts/`.
