# Spec-history replay

Could SHAPI have drafted a provider's breaking changes from its published OpenAPI spec alone, before anyone read the changelog? Each replay diffs two versions of the spec, drafts every change a client could trip over as an `unverified` advisory, and scores the changes against the provider's own list of breaking changes. Drafts are written to the results files and **are not published**.

## Stripe

Could SHAPI have drafted Stripe's breaking changes from the published OpenAPI spec alone, before anyone read the changelog? This replays four Stripe releases (execution plan P-08):

- **The two specs.** For each release, the last commit of [`stripe/openapi`](https://github.com/stripe/openapi)'s `openapi/spec3.json` on the previous API version, and the first on the new one.
- **The diff.** What a client could trip over between them: an operation or response status gone, a request parameter gone or newly required, an enum value gone or added, a response property gone or retyped, a schema gone.
- **Drafts.** Each change is drafted as an `unverified` SHAPI advisory, with its change class, endpoint and trigger. Every draft validates against the advisory schema. They are written to the results files and **are not published**.
- **The score.** The changes are matched against the release's changelog on [docs.stripe.com](https://docs.stripe.com/changelog), field by field.

Run it again with `pnpm --filter @shapi/bench bench:spec-replay`. It reads public GitHub and docs.stripe.com pages only, cached under `.cache/spec-replay`.

### How it is scored

- **Which changelog rows count.** Only the entries of a release's first version date, which is when Stripe ships its breaking changes, in the `api` category. Stripe.js entries are counted apart and not scored.
- **Recall** is measured against the rows Stripe labels **Breaking**. A breaking entry is found when one spec change matches one of the fields in its "REST API" table: the same last field segment, an overlapping enum value for enum rows, and the entry's resource found in the change's schema or path.
- **False positives** are spec changes that match only rows Stripe labels **Non-breaking**.
- **Breaking entries a spec diff cannot show** get their own buckets, so they don't count as misses:
  - **Behavior only:** the entry has no REST field table. The change is in what the API does, not in its shape.
  - **v2 APIs:** every resource is a `v2.*` API. `stripe/openapi`'s `spec3.json` covers v1 only.
  - **Preview APIs:** every link in the entry points at the preview API version. The GA spec doesn't carry preview changes.

### Results

<!-- table:start -->
Run on 2026-10-30. Results: [results/spec-replay/stripe/](results/spec-replay/stripe/).

| Release | Spec commits (before → after) | Spec changes found | GA breaking REST API rows | Found in the spec diff | Behavior only (no field change) | v2 APIs (not in the published spec) | Preview APIs (not in the GA spec) | Field changes the diff missed | Changes matching a breaking / only a non-breaking row | Stripe.js rows (not scored) |
|---|---|---|---|---|---|---|---|---|---|---|
| basil (`2025-03-31.basil`) | [`5a411d0`](https://github.com/stripe/openapi/commit/5a411d0d1e527229cdb4d6633197ab8009899ce6) → [`9fa5188`](https://github.com/stripe/openapi/commit/9fa5188b0933d46d2ac3c601d2d9c50904fb54de) | 145 | 21 | 10 (48%) | 8 (38%) | 0 | 0 | 3 | 83 / 4 (4 entries) | 1 |
| clover (`2025-09-30.clover`) | [`62fbe07`](https://github.com/stripe/openapi/commit/62fbe0713198e910b8843f70fdcd351be3ec979c) → [`7861d49`](https://github.com/stripe/openapi/commit/7861d4985575906da4c2c8eafd8572e3bf0a3adf) | 20 | 15 | 2 (13%) | 6 (40%) | 1 | 2 | 4 | 5 / 4 (3 entries) | 6 |
| dahlia (`2026-03-25.dahlia`) | [`da3eadb`](https://github.com/stripe/openapi/commit/da3eadb239b437b59cdf3459768bc2a6672165f6) → [`cfe95bf`](https://github.com/stripe/openapi/commit/cfe95bf4b8074b8d8957b8ed9b10988e4fa0d9c3) | 29 | 8 | 3 (38%) | 2 (25%) | 1 | 2 | 0 | 3 / 9 (5 entries) | 6 |
| endive (`2026-09-30.endive`) | [`30d3391`](https://github.com/stripe/openapi/commit/30d3391cc09a0f67ad29bee002f570811b19e1da) → [`c8faccb`](https://github.com/stripe/openapi/commit/c8faccbde66b784ea916d3c28f5790d7a9c9aee2) | 66 | 34 | 5 (15%) | 6 (18%) | 5 | 8 | 10 | 10 / 14 (9 entries) | 6 |
<!-- table:end -->

Across the four releases there are **78 GA breaking REST API entries**:

- **41 (53%) can't be seen in the published spec**: 22 are behavior changes, 7 are v2 APIs and 12 are preview APIs.
- **Of the 37 a spec diff could show, it finds 20 (54%).** Dahlia: 3 of 3. Basil: 10 of 13. Endive: 5 of 15. Clover: 2 of 6.
- **For Endive and Dahlia together**, the two most recent releases: 8 of 42 breaking entries are found. 24 (57%) are invisible in the spec, and the diff finds 8 of the 18 it could show (44%).
- **Precision.** 101 of the 260 spec changes match a breaking entry, and 31 match only a non-breaking one (9 of them in Dahlia, 14 in Endive). The other 128 match no row: Stripe lists one entry per feature, and one entry can cover dozens of parameters (Basil's 83 matching changes come from 10 entries).

### What it misses, and why

- **Error codes.** Entries like "Adds Failed Tax Calculation error" add an error `code`. The spec types `code` as a free string, so there is no enum value to diff.
- **Changes the diff doesn't detect.** "Unifies the billing cycle anchor format" and the `requirements.errors` changes are format and type changes the diff doesn't flag: it compares properties at most 4 levels deep, and only by name, type and enum values.
- **APIs missing from the GA spec without a preview label.** Endive's Reserve Plan, Hold and Release entries link to the GA version, but `spec3.json` has no paths for them. They count as misses.
- **Matching by name.** A change that is in the diff but on a resource the entry names differently isn't matched to it. These count as misses too, so recall is a lower bound.
- **Labels.** The false positives are spec changes Stripe labels Non-breaking, such as a parameter removed where it was never valid. A client that sent it would still get an error, so some of these are breaking for a client even if not by Stripe's definition.

### What this means for SHAPI

- **The spec diff is worth running.** It drafts advisories for about half of what it could show, on the day the spec changes, before a changelog is read.
- **It can't be the only source.** Over half of Stripe's breaking changes are behavior, v2 or preview changes that no published spec shows. That is the case for live probes and recorded shapes, which see what the API returns rather than what its spec says.
- **Drafts stay unverified.** A spec diff says a field changed. It doesn't say when a pinned client sees it, or whether the provider counts it as breaking. A person (or a probe) checks a draft before it is published.

## GitHub

GitHub publishes one description per REST API version side by side in [`github/rest-api-description`](https://github.com/github/rest-api-description), so this replay (execution plan P-09) diffs `2022-11-28` against `2026-03-10` at the same commit. The changes are scored against the `2026-03-10` section of GitHub's [breaking-changes page](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes?apiVersion=2026-03-10), which lists each change with its affected endpoints.

- **Found:** a spec change matches an entry when it is on one of the entry's endpoints (or in a schema they return) and, when the title names fields, values or status codes, on one of them.
- **Added status codes count.** GitHub lists a new error status as breaking (403 becoming 451), so this replay also reports status codes an operation newly answers. The Stripe replay doesn't.
- **Behavior only:** a media type, a content type or a validation rule. No field, value or status code in a spec shows them.

Run it again with `pnpm --filter @shapi/bench bench:spec-replay:github`.

<!-- github:start -->
Run on 2026-10-30. Results: [results/spec-replay/github/](results/spec-replay/github/). `GET /versions` answered `2026-03-10`, `2022-11-28`.

| Versions | Spec commit | Spec changes found | Breaking entries | Found in the spec diff | Behavior only | Found, of those a spec can show | Changes matching a listed break / none |
|---|---|---|---|---|---|---|---|
| `2022-11-28` → `2026-03-10` | [`443ef15`](https://github.com/github/rest-api-description/tree/443ef1513a17aad7f781391c4fb4e132b9b549fd/descriptions/api.github.com) | 115 | 26 | 20 (77%) | 3 | 20 of 23 (87%) | 35 / 80 |
<!-- github:end -->

- **20 of 26 breaking changes are found (77%), 20 of the 23 a spec can show (87%).** They include the workflow dispatch `204` → `200` change that SHAPI's first advisory is about, the five `451` trade-controls statuses, and the removed `rate`, `merge_commit_sha`, `has_downloads` and `assignee` fields.
- **Behavior only (3):** the SARIF content type, the `beta` media type, and `selected_repository_ids` accepting only integers.
- **Missed (3):**
  - `/hub` is in neither spec, so there is nothing to diff.
  - The attestation `bundle` property sits in a response schema written inline, which the diff doesn't compare (it compares component schemas).
  - Submodules listed with `type` "submodule" instead of "file" is a change in meaning, not in the schema.
- **What GitHub doesn't list.** 35 of the 115 spec changes match a listed break. Of the other 80:
  - 53 are the same breaks in webhook payload schemas, and 19 in schemas nested inside other responses, which the scoring doesn't tie to an endpoint;
  - 4 are changes the page doesn't mention: `master_branch` and `base-gist.user` removed from responses, and `return_run_details` removed from the workflow dispatch request;
  - the issue `pull_request` URLs became non-nullable. That's safe for a client that reads them, so it's a false positive of the diff.

## Files

- [`src/spec-replay.ts`](src/spec-replay.ts): the diff, the changelog parsers, matching, scoring and drafting.
- [`src/spec-replay-github.ts`](src/spec-replay-github.ts): GitHub's breaking-changes page parser, matching and scoring.
- [`scripts/spec-replay.ts`](scripts/spec-replay.ts) and [`scripts/spec-replay-github.ts`](scripts/spec-replay-github.ts): find the spec versions, fetch the changelogs, write the results and these tables.
- [`results/spec-replay/stripe/`](results/spec-replay/stripe/) and [`results/spec-replay/github/`](results/spec-replay/github/): the score (with every missed entry and why), the spec changes, and the drafted advisories.
