# PB-65: Wayback Machine captures of every advisory source (execution plan P-13)

## Why

An advisory rests on its sources: a changelog entry, a docs page, a provider's notice. Providers edit and delete those pages. A dated, independent copy keeps the evidence checkable.

## What changes

- **`pnpm --filter @shapi/bench bench:wayback`** looks up the Internet Archive's earliest capture that answered 200 for every source of every advisory, through the public CDX API.
  - It never asks the archive to save a page.
  - It sends one request every 1.5 s and retries on 429 and 5xx.
  - A capture once found is kept; sources without one are looked up again on the next run.
- **`advisories/evidence/captures.json`** records, per advisory:
  - each source's `firstCaptured` time and capture URL, or a `note` saying why there's none;
  - a summary.
  - `loadAdvisories` skips the folder, so no advisory file changes.
- **`src/wayback.ts`:** `cdxUrl`, `parseCdx`, `waybackTime`, `firstCapture`.

## Results (2026-10-30)

- **63 verified advisories.** 61 (97%) have at least one captured source, and all 63 have every source accounted for: a capture, or a "no capture" note. The P-13 target is 90%.
- **132 sources, 108 captured.** The two verified advisories with no capture both cite one Salesforce help article the archive doesn't hold.
- **Not done yet:** matching each capture to the advisory's quote (P-13's "first capture containing the quote"). It needs the provenance quotes C-02 adds. Until then the file records the first capture of each URL.

## Verified

- **Unit tests** (`packages/bench/test/wayback.test.ts`):
  - the CDX query;
  - timestamp parsing;
  - a capture and an empty answer;
  - a 429 retried, a lookup that keeps failing recorded with why instead of throwing, and an empty body counted as no capture.
- **Real run:** `advisories/evidence/captures.json`, with no failed lookups.
- **Checks:** typecheck, lint, and the bench and core tests pass. CI runs the full suite.
