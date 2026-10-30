# PB-46: The benchmark runs in CI as the matcher's regression suite (execution plan P-05)

## Why

APIBreak-Replay measured SHAPI once, by hand. A change to the extractor or matcher could quietly lose a catch or flag a commit that is already fixed, and nothing would notice until the next manual run.

## What changes

- **The gate.** `packages/bench/src/gate.ts` holds three functions:
  - `baselineFrom()` records every in-scope instance's base and fix verdicts, plus the headline rates.
  - `checkAgainstBaseline()` compares a run with that baseline instance by instance.
  - `gateReport()` writes the result as Markdown.
- **When the gate fails:**
  - a lost catch: `affected` at the base commit before, not now;
  - a new false positive: not `affected` at the fix commit before, `affected` now;
  - an instance that could not be scanned for any reason other than a 404.
- **When it passes but reports:** a 404 (repository or commit gone) is listed, not failed. Improvements pass and ask for `--update-baseline`. A changed dataset fails until the baseline is rebuilt.
- **`baseline.json`.** Built from a fresh run on main at 4fb4c68: flag recall 5 / 14, fixed-state precision 13 / 14.
- **`bench:run` flags:**
  - `--cache <dir>` keeps downloaded archives, because a commit's archive never changes;
  - `--check` runs the gate, writes the report to the job summary, and exits 1 on failure;
  - `--update-baseline` rewrites `baseline.json`.
- **CI.** A new `bench` job runs the gate on every PR and push to main, with the archive cache in `actions/cache`, about 185 MB. The job uses the workflow's read-only token to download public archives.

## Verified

- **The real run:** the gate passes on main, at 5 / 14 and 13 / 14, from the cache in about 2 minutes.
- **The deliberate break:** with #93's matcher fix undone, the gate fails and exits 1. Recall drops from 5 / 14 to 4 / 14, and the report names the lost catch: `vincentng295/gemini_fbchat: base affected → none`. The matcher was restored afterwards.
- **Tests:**
  - the baseline's contents;
  - pass on the same run;
  - improvements pass;
  - a lost catch fails even when another instance is newly caught and the rate stays the same;
  - a new false positive fails;
  - a scan error fails, while a 404 is only reported, and a missing instance fails;
  - a different dataset is refused;
  - the report names the failure;
  - the committed baseline matches the committed dataset.
- **Full suite:** typecheck, lint and the full test suite.

## For the founder

To make the gate block merges you do by hand, add **`bench`** to the required status checks of `main`'s branch protection: GitHub → Settings → Branches. My merge-on-green script already waits for every check, `bench` included.
