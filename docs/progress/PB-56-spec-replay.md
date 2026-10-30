# PB-56: Spec-history replay for Stripe (execution plan P-08)

## Why

SHAPI's advisories are written by hand from changelogs. The question for P-08: how much of a provider's breaking change could SHAPI draft on its own from the provider's published OpenAPI spec, and how much can no spec show?

## What changes

- **`packages/bench/src/spec-replay.ts`:**
  - `diffSpecs()` lists what a client could trip over between two versions of a spec: an operation or response status gone, a request parameter gone (nested ones too) or newly required, an enum value gone or added, a response property gone or retyped, a schema gone. Each has a SHAPI change class.
  - `draftAdvisory()` drafts each change as an `unverified` advisory, with its endpoint (from the operations returning the schema) and its trigger.
  - `parseReleasePage()` and `parseEntryChanges()` read Stripe's changelog: the release's Breaking and Non-breaking rows, and each entry's REST API tables in Stripe's three shapes (parameters, fields, enum values).
  - `scoreRelease()` scores the changes against the GA `api` entries of the release's first version date. It counts recall against Breaking entries and false positives against Non-breaking ones. Breaking entries no spec can show go in their own buckets: behavior only, v2 APIs, and preview APIs.
- **`pnpm --filter @shapi/bench bench:spec-replay`** replays Basil, Clover, Dahlia and Endive from `stripe/openapi`'s `spec3.json` history. It writes `results/spec-replay/stripe/<release>.json` (the score with every missed entry and why, the changes, the drafts) and the table in `packages/bench/SPEC-REPLAY.md`. Drafts are not published.

## Results

- **78 GA breaking REST API entries** across the four releases.
- **41 (53%) can't be seen in the published spec:** 22 behavior changes, 7 v2 APIs, 12 preview APIs.
- **The diff finds 20 of the 37 it could show (54%).**
- **Endive and Dahlia:** 8 of 42 found, 24 (57%) invisible in the spec, 8 of 18 found among the rest (44%).
- **Precision:** 101 of 241 spec changes match a breaking entry; 20 match only a non-breaking one.

The prose, limits and what this means for SHAPI are in `packages/bench/SPEC-REPLAY.md`.

## Verified

- **Unit tests** (`packages/bench/test/spec-replay.test.ts`): the diff on two small Stripe-shaped specs, drafts validating against the advisory schema, all three changelog table shapes (including Stripe's singular and plural headers), matching, and every score bucket.
- **Drafts:** all 241 drafted advisories validate against `AdvisorySchema`.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
