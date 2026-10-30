# PB-60: The promotion rule, in code (execution plan C-03)

## Why

`verified` was a label a person set by hand. Nothing enforced what it takes, and an unverified advisory with a recipe would have opened fix PRs like any other.

## What changes

- **`provenance`** is a new, optional advisory field: a list of sources as SHAPI fetched them. Each has the URL, the quote that backs the advisory, the SHA-256 of the page body, and the time it was fetched. C-02 fills it in for every verified advisory and checks each quote in CI. The JSON Schema (`packages/core/schema/advisory.schema.json`, `site/public/schema/advisory.json`) is regenerated.
- **`promotionCheck(advisory, { witnessed })`** says whether an advisory may become `verified`, and what it lacks:
  - provenance (at least one fetched source with its quote), and
  - a witness (SHAPI saw the change itself: the advisory's `evidence`, or a before/after the caller found), or a second source on another site. Two pages on the same site count as one source.
- **`opensPullRequests(advisory)`:** only `verified` advisories open pull requests.
  - The fix job reports an unverified advisory's findings as `unverified` and doesn't open a sandbox or a PR. They still show on the check and the dashboard.
  - `shapi fix --pr` skips the PR for an unverified advisory. `--write` still applies its fix locally.

## Verified

- **Unit tests** (`packages/core/test/promotion.test.ts`):
  - provenance is required first, and a witness alone isn't enough;
  - then a witness or a second source on another site (`www.` and the bare domain count as the same site);
  - only verified advisories open PRs, checked across every bundled advisory;
  - provenance entries validate.
- **Server test:** an unverified advisory whose recipe could fix the demo repository gets no sandbox run and no PR.
- **Full suite:** typecheck, lint and tests pass.

The public `shapi-advisories` mirror needs the regenerated schema. That waits for the next deploy, per the release order.
