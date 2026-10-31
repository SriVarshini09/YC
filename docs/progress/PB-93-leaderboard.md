# PB-93: A leaderboard that accepts other tools' results (execution plan P-15)

## What changes

- **Submissions** (`packages/bench/SUBMISSIONS.md`): any tool's verdicts on the 14 scored APIBreak-Replay instances, one `submissions/<tool>.json` each. For every instance the file says `flagged`, `clear` or `error`, at the base commit and at the fix commit. It names the dataset and its hash, and how to reproduce the run.
- **Scoring** (`src/leaderboard.ts`): the same metrics as SHAPI's own run, with Wilson intervals.
  - Flag recall: the share of instances flagged at the base commit.
  - Fixed-state precision: the share clear at the fix commit.
  - Errors count against the tool.
  - SHAPI's row comes from its latest `bench:run` result, through the same scorer.
- **`bench:leaderboard`** validates every submission and rewrites the table in `LEADERBOARD.md`. A submission must cover exactly the scored instances of the current dataset, with known verdicts and an https URL. CI runs `bench:leaderboard -- --check`, which fails on an invalid submission or a stale table.
- **The first submission** is a grep baseline (`bench:baseline-grep`), written in the outside format and processed by the same validation and scoring: a `204` in a file that says `dispatches`, or a `minorversion` below 75.

| Tool | Flag recall | Fixed-state precision |
| --- | --- | --- |
| grep baseline | 14/14 | 4/14 |
| SHAPI 0.3.1 | 5/14 | 13/14 |

## Not done

The grep baseline was run by SHAPI's maintainers, not by an outside team. A submission from another tool's authors is P-19.

## Verified

- `leaderboard.test.ts` accepts the grep baseline's file and scores it 14/14 and 4/14. It scores SHAPI's run to the same counts as its own summary. It rejects a file that misses an instance, adds one, uses another dataset hash, has an unknown verdict, or lacks a tool name or an https URL.
- `bench:leaderboard -- --check` passes on the committed files.
