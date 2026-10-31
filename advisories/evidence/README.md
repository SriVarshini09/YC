# Advisory evidence

`captures.json` holds the Wayback Machine's earliest capture (HTTP 200) of every advisory source, so an advisory's evidence survives a provider editing or deleting its page. A source with no capture says so in a `note`.

It is written by `pnpm --filter @shapi/bench bench:wayback`, which reads the archive's public CDX API and never asks it to save a page. A capture once found is kept; sources without one are looked up again on the next run.

## Quotes and snapshots (C-02)

Each verified advisory's `provenance` lists the sources that back it, each with the provider's exact words (`quote`), the SHA-256 of the page as fetched (`sourceSha256`) and the fetch time. `snapshots/<sourceSha256>.txt` keeps the lines each quote is on, with one line of context either side (cut to 200 characters), separated by `...` where they are apart. It holds just enough of the page to check the quote, not a copy of the page. CI (`packages/core/test/provenance.test.ts`) fails when:

- a verified advisory has no provenance;
- a quote is not in its snapshot (text compared as a reader sees it: tags gone, entities decoded, curly quotes, dashes and whitespace folded);
- a snapshot is missing;
- a provenance URL is not one of the advisory's sources or a Wayback capture of one.

`pnpm --filter @shapi/bench bench:provenance` fetches the sources of verified advisories that have no provenance yet (`-- --redo <id>…` fetches those again). It picks the sentence that says something changes and shares the most rare words with the advisory. A page that can't be fetched, or has no such sentence without JavaScript, is read from its Wayback capture. Where the automatic pick was wrong, often because a page keeps its dates in table cells, `quote-hints.json` holds a reviewed pattern for what to quote, matched over up to `lines` lines read together, as a table row is.

Five pages render their text only with JavaScript. They were read in a browser, and their `sourceSha256` is the SHA-256 of the rendered text (`document.body.innerText`), not of the HTML:

- the Google Ads Developer Blog (`google-ads-api-v22-sunset`);
- Salesforce Help (the three `salesforce-soap-login-*` advisories);
- the Twilio Help Center (`twilio-notify-end-of-life`, its first entry);
- Intuit's posts on Medium (`quickbooks-companyinfo-neoenabled-removed`, `quickbooks-refresh-token-five-year-hard-expiry`).

`loadAdvisories` skips this folder, like `drafts/`.
