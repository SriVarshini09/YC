# PB-45: Head-to-head with Okapi on its public PRs, scan only (execution plan P-04)

## Why

Okapi is the closest competitor that opens fix PRs. A YC reviewer or a design partner will ask how SHAPI compares, and the answer should be a table anyone can check, with exact commits.

## What changes

- **Dataset.** `packages/bench/datasets/okapi-prs.json` lists every public PR Okapi (`okapi-agent`) had opened by 2026-10-29: 14 PRs in 9 repositories. For each one it records:
  - the base commit;
  - the files and base-commit lines Okapi changed (`removedLines()`);
  - hand-checked fields: the change's kind and provider, Okapi's target, SHAPI's advisories on the same change, and SHAPI's target.
- **Comparison.** `okapiRow()` scores each PR: SHAPI's verdict for its own advisories on that change (affected, possible, exposed, missed, no advisory, not scanned), whether that finding is in a file Okapi changed, fix-target agreement, and SHAPI's other affected findings in Okapi's files. `okapiTable()` writes the Markdown table.
- **Scanning.** `scanRepo()` returns the full match. `scanCommit()` now uses it.
- **Runner.** `pnpm --filter @shapi/bench bench:okapi` scans each base commit once, writes `results/okapi/<version>/<dataset hash>.json`, and regenerates the table in `packages/bench/OKAPI.md`. That file also carries the write-up.

## Results (SHAPI 0.3.1, git d569bbe)

- **Languages:** 9 of the 14 PRs are in languages SHAPI scans. The 5 PumpWatch3 PRs are Kotlin bug fixes.
- **Coverage:** SHAPI has advisories for 3 of the changes, and all 3 name the same target as Okapi's diff.
- **Found and missed:** SHAPI found 1 of the 3, studymind-ai's `gemini-2.0-flash` call. It missed 2:
  - tugpt's Graph version, held in a class field;
  - MoneyPrinterTurbo's TTS model, on a `with genai.Client(...) as client` call.
- **No advisory:** 6 scanned changes have no SHAPI advisory: 4 model retirements and 2 rejected parameters.
- **Beyond Okapi:** SHAPI found 1 affected call site Okapi's PR does not mention: an unauthenticated Reddit `.json` fetch in the file Okapi changed in youtube.
- **No side effects:** no PR, issue or comment was opened anywhere. Nothing in the repositories was run.

## Verified

- **Tests:**
  - `removedLines()` reads hunk line numbers;
  - `okapiRow()` covers every verdict, the same-file flag, other findings (affected only) and each fix-agreement case;
  - `okapiTable()` writes the expected row;
  - the dataset holds 14 unique PRs with 40-character base commits and advisory ids that exist;
  - the published results and OKAPI.md agree.
- **Full suite:** typecheck, lint and the full test suite.

## Follow-ups this turned up

- Extractor: follow values held in class fields, and Python clients bound with `with … as` (the two misses).
- Advisories: model-catalog ingestion (models.dev, provider deprecation pages) for the retirements SHAPI has no advisory for.
- Not measured here: whether Okapi's public data knows the changes in APIBreak-Replay.
