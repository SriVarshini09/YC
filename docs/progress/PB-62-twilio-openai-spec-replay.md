# PB-62: Spec-history replay for Twilio and OpenAI (execution plan P-10)

## Why

P-08 and P-09 measured, on Stripe and GitHub, how many of a provider's breaking changes its published spec shows. P-10 does the same for Twilio, scored against its CHANGES.md, and OpenAI, scored against its deprecations page.

## What changes

- **`bench:spec-replay:twilio`:**
  - For each `twilio/twilio-oai` release since 2.1.0 with a breaking line, it diffs the named products' spec files at that release's tag against the previous one.
  - `src/spec-replay-twilio.ts` reads CHANGES.md in both formats Twilio uses: the `(breaking change)` tag, and a `**Breaking change**:` lead-in followed by lines. It maps a product to its spec files and scores each line.
- **`bench:spec-replay:openai`:**
  - For each deprecations-page entry announced since `openapi.json` was first published, it diffs the last spec before the announcement against the current one.
  - `src/spec-replay-openai.ts` reads each entry's table, including escaped `\|` between aliases. It scores each row as shown or not, and says why: the model is still listed, or it isn't named at all.
- **The diff:**
  - opt-in `deprecations` reports an operation newly marked `deprecated: true` (`operation-deprecated`);
  - changes can carry the spec `file` they came from.
- **`SPEC-REPLAY.md`** gains Twilio and OpenAI sections and a summary table across all four providers.
- **Results:** `results/spec-replay/twilio/replay.json` and `results/spec-replay/openai/replay.json` hold scores, entries, changes and unverified drafts.

## Results

- **Twilio:** 5 of 14 breaking lines found (36%); 5 of the 7 a spec can show (71%).
  - 3 are TwiML, which is XML with no REST spec.
  - 4 name no field.
  - 2 missed.
- **OpenAI:** 1 of 26 rows shown.
  - The one endpoint (`/v1/audio/translations`) is marked `deprecated: true`.
  - None of the 25 model rows show: 17 models are still in the spec's enums with nothing marking them, and 8 aren't named in it. That includes `gpt-5.4-cyber`, which is past its shutdown.
  - Model deprecations need the deprecations page and models.dev (C-04), not the spec.

## Verified

- **Unit tests:**
  - the Twilio parser on both breaking formats;
  - product-to-file mapping;
  - Twilio scoring buckets;
  - the OpenAI page parser with escaped pipes;
  - `operation-deprecated` only when asked;
  - OpenAI scoring and its two miss reasons.
- **Real runs:** the results files above.
- **Checks:** typecheck, lint and the bench tests pass. CI runs the full suite.
