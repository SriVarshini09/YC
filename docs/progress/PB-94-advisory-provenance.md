# PB-94: Every verified advisory carries the provider's exact quote (execution plan C-02)

## What changes

- **All 63 verified advisories now have `provenance`.** For each source that backs one, the entry holds:
  - the provider's words as the page has them;
  - the SHA-256 of the page as fetched;
  - the fetch time.

  There are 82 quotes, from 62 pages.
- **Snapshots:** `advisories/evidence/snapshots/<sha256>.txt` keeps the lines each quote is on, with one line of context either side. That is just enough to check the quote, not a copy of the provider's page: 27 KB in all, at most 2.3 KB per page.
- **The CI check** is `packages/core/src/provenance.ts` (`provenanceProblems`), run over the whole database by `packages/core/test/provenance.test.ts`. It fails on:
  - a verified advisory without provenance;
  - a quote missing from its snapshot;
  - a missing snapshot;
  - a provenance URL that isn't one of the advisory's sources or a Wayback capture of one.

  Text is compared as a reader sees it: tags removed, entities decoded, curly quotes, dashes and whitespace folded.
- **`bench:provenance`** fetches the sources, falls back to the Wayback capture, and picks the sentence that says something changes and shares the most rare words with the advisory.
  - It only accepts sentences that state a change, and keeps only strong quotes, or each advisory's single best one.
  - English pages are requested.
  - `quote-hints.json` holds 27 reviewed patterns for the pages where the automatic pick was wrong, mostly dates kept in table cells, matched over a few lines read together like a table row.
- **Rendered pages:** five pages render their text only with JavaScript: the Google Ads blog, Salesforce Help, the Twilio Help Center and two Intuit posts on Medium. They were read in a browser, and their hash is of the rendered text; `advisories/evidence/README.md` lists them.
- **Notices count as sources:** a provenance URL may also be the advisory's `publishedNotice`, the provider's own notice. HubSpot's Pipelines v1 notice was not among its sources.

## Release

The advisories' source of truth is `SriVarshini09/shapi-advisories`. The same files go there after this is merged and deployed, per the release order.

## Verified

- `provenance.test.ts` passes on the database. The same test rejects:
  - an edited quote ("…not in its snapshot");
  - a wrong hash ("no snapshot");
  - a foreign URL;
  - a verified advisory with none.

  It also accepts a quote with curly quotes and an em dash against a page with straight ones and `&mdash;`.
- I read every one of the 82 quotes: each states the change its advisory describes, in the provider's words or, for a few, an independent source's.
