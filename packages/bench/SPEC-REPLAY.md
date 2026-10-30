# Spec-history replay: Stripe

Could SHAPI have drafted Stripe's breaking changes from the published OpenAPI spec alone, before anyone read the changelog? This replays four Stripe releases (execution plan P-08):

- **The two specs.** For each release, the last commit of [`stripe/openapi`](https://github.com/stripe/openapi)'s `openapi/spec3.json` on the previous API version, and the first on the new one.
- **The diff.** What a client could trip over between them: an operation or response status gone, a request parameter gone or newly required, an enum value gone or added, a response property gone or retyped, a schema gone.
- **Drafts.** Each change is drafted as an `unverified` SHAPI advisory, with its change class, endpoint and trigger. Every draft validates against the advisory schema. They are written to the results files and **are not published**.
- **The score.** The changes are matched against the release's changelog on [docs.stripe.com](https://docs.stripe.com/changelog), field by field.

Run it again with `pnpm --filter @shapi/bench bench:spec-replay`. It reads public GitHub and docs.stripe.com pages only, cached under `.cache/spec-replay`.

## How it is scored

- **Which changelog rows count.** Only the entries of a release's first version date, which is when Stripe ships its breaking changes, in the `api` category. Stripe.js entries are counted apart and not scored.
- **Recall** is measured against the rows Stripe labels **Breaking**. A breaking entry is found when one spec change matches one of the fields in its "REST API" table: the same last field segment, an overlapping enum value for enum rows, and the entry's resource found in the change's schema or path.
- **False positives** are spec changes that match only rows Stripe labels **Non-breaking**.
- **Breaking entries a spec diff cannot show** get their own buckets, so they don't count as misses:
  - **Behavior only:** the entry has no REST field table. The change is in what the API does, not in its shape.
  - **v2 APIs:** every resource is a `v2.*` API. `stripe/openapi`'s `spec3.json` covers v1 only.
  - **Preview APIs:** every link in the entry points at the preview API version. The GA spec doesn't carry preview changes.

## Results

<!-- table:start -->
Run on 2026-10-30. Results: [results/spec-replay/stripe/](results/spec-replay/stripe/).

| Release | Spec commits (before → after) | Spec changes found | GA breaking REST API rows | Found in the spec diff | Behavior only (no field change) | v2 APIs (not in the published spec) | Preview APIs (not in the GA spec) | Field changes the diff missed | Changes matching a breaking / only a non-breaking row | Stripe.js rows (not scored) |
|---|---|---|---|---|---|---|---|---|---|---|
| basil (`2025-03-31.basil`) | [`5a411d0`](https://github.com/stripe/openapi/commit/5a411d0d1e527229cdb4d6633197ab8009899ce6) → [`9fa5188`](https://github.com/stripe/openapi/commit/9fa5188b0933d46d2ac3c601d2d9c50904fb54de) | 142 | 21 | 10 (48%) | 8 (38%) | 0 | 0 | 3 | 83 / 2 (3 entries) | 1 |
| clover (`2025-09-30.clover`) | [`62fbe07`](https://github.com/stripe/openapi/commit/62fbe0713198e910b8843f70fdcd351be3ec979c) → [`7861d49`](https://github.com/stripe/openapi/commit/7861d4985575906da4c2c8eafd8572e3bf0a3adf) | 15 | 15 | 2 (13%) | 6 (40%) | 1 | 2 | 4 | 5 / 2 (2 entries) | 6 |
| dahlia (`2026-03-25.dahlia`) | [`da3eadb`](https://github.com/stripe/openapi/commit/da3eadb239b437b59cdf3459768bc2a6672165f6) → [`cfe95bf`](https://github.com/stripe/openapi/commit/cfe95bf4b8074b8d8957b8ed9b10988e4fa0d9c3) | 26 | 8 | 3 (38%) | 2 (25%) | 1 | 2 | 0 | 3 / 8 (4 entries) | 6 |
| endive (`2026-09-30.endive`) | [`30d3391`](https://github.com/stripe/openapi/commit/30d3391cc09a0f67ad29bee002f570811b19e1da) → [`c8faccb`](https://github.com/stripe/openapi/commit/c8faccbde66b784ea916d3c28f5790d7a9c9aee2) | 58 | 34 | 5 (15%) | 6 (18%) | 5 | 8 | 10 | 10 / 8 (6 entries) | 6 |
<!-- table:end -->

Across the four releases there are **78 GA breaking REST API entries**:

- **41 (53%) can't be seen in the published spec**: 22 are behavior changes, 7 are v2 APIs and 12 are preview APIs.
- **Of the 37 a spec diff could show, it finds 20 (54%).** Dahlia: 3 of 3. Basil: 10 of 13. Endive: 5 of 15. Clover: 2 of 6.
- **For Endive and Dahlia together**, the two most recent releases: 8 of 42 breaking entries are found. 24 (57%) are invisible in the spec, and the diff finds 8 of the 18 it could show (44%).
- **Precision.** 101 of the 241 spec changes match a breaking entry, and 20 match only a non-breaking one (8 of them in Dahlia, 8 in Endive). The other 120 match no row: Stripe lists one entry per feature, and one entry can cover dozens of parameters (Basil's 83 matching changes come from 10 entries).

## What it misses, and why

- **Error codes.** Entries like "Adds Failed Tax Calculation error" add an error `code`. The spec types `code` as a free string, so there is no enum value to diff.
- **Changes the diff doesn't detect.** "Unifies the billing cycle anchor format" and the `requirements.errors` changes are format and type changes the diff doesn't flag: it compares properties at most 4 levels deep, and only by name, type and enum values.
- **APIs missing from the GA spec without a preview label.** Endive's Reserve Plan, Hold and Release entries link to the GA version, but `spec3.json` has no paths for them. They count as misses.
- **Matching by name.** A change that is in the diff but on a resource the entry names differently isn't matched to it. These count as misses too, so recall is a lower bound.
- **Labels.** The false positives are spec changes Stripe labels Non-breaking, such as a parameter removed where it was never valid. A client that sent it would still get an error, so some of these are breaking for a client even if not by Stripe's definition.

## What this means for SHAPI

- **The spec diff is worth running.** It drafts advisories for about half of what it could show, on the day the spec changes, before a changelog is read.
- **It can't be the only source.** Over half of Stripe's breaking changes are behavior, v2 or preview changes that no published spec shows. That is the case for live probes and recorded shapes, which see what the API returns rather than what its spec says.
- **Drafts stay unverified.** A spec diff says a field changed. It doesn't say when a pinned client sees it, or whether the provider counts it as breaking. A person (or a probe) checks a draft before it is published.

## Files

- [`src/spec-replay.ts`](src/spec-replay.ts): the diff, the changelog parsers, matching, scoring and drafting.
- [`scripts/spec-replay.ts`](scripts/spec-replay.ts): finds the spec commits, fetches the changelog, writes the results and this table.
- [`results/spec-replay/stripe/`](results/spec-replay/stripe/): for each release, the score (with every missed entry and why), the spec changes, and the drafted advisories.
