# PB-37: APIBreak-Replay v0 (execution plan P-01, P-02, P-03)

## Why

SHAPI's claims need a public, re-runnable number. APIBreak-Replay replays real third-party API breakages that public repositories fixed by hand. SHAPI scans each one before the fix, where it should flag the code, and at the fix, where it shouldn't.

## What changes

- **New package `packages/bench` (`@shapi/bench`):**
  - `src/instances.ts`: the instance format, the scoring rule for each hand label, and the evidence rule. An instance is scored only when the fix removes a line showing the old behavior.
  - `src/metrics.ts`: verdicts, Wilson intervals and the summary.
  - `src/scan.ts`: downloads a repository at a commit through GitHub's API and scans it statically. Downloads are retried; entries the file system can't create are skipped.
  - `scripts/build.ts`: builds the dataset from the verified commit-mining CSV.
  - `scripts/run.ts`: runs SHAPI over the dataset.
- **`datasets/apibreak-v0.json`:** 71 instances, 14 scored, 1 unavailable. Every unscored instance keeps its reason.
- **`results/0.3.1/37fa931e8278.json`:** the first run.
- **`METHODOLOGY.md`:** the definitions, how to run it, the baseline, one adjudication, the gaps the misses show, and the limits.

## Baseline

| Metric | k / n | 95% interval |
| --- | --- | --- |
| Flag recall | 4 / 14 (29%) | 12–55% |
| Flag recall in scanned files | 4 / 10 (40%) | 17–69% |
| Fixed-state precision | 13 / 14 (93%) | 69–99% |

The one flag that survives a human fix is right: hfscdogg/outgrow's fix left `minorversion=65` in `scripts/smoke_creds.py`.

## Not done here

- **Fix rate:** this needs fixes run in the sandbox, so it's `null` in the results. It follows with V-01.
- **Benchmark in CI (P-05):** it needs a GitHub token in CI.
- **Archiving the repositories (P-07).**
- **Closing the gaps** listed in `METHODOLOGY.md`. Each gets its own PR, measured by this benchmark.
