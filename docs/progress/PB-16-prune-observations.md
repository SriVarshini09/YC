# PB-16: prune repeated canary observations

## Why

The hosted canary records one observation per probe per hour, and nothing ever deleted them. That's about 720 rows per probe per month, nearly all of them the same shape as the one before.

## What changes

- **`PgShapeStore.prune(before)`** deletes an observation older than `before` only when a newer observation of the same endpoint and source has the same shape hash.
  - The newest observation of every distinct shape is kept for good, however old.
  - So shape diffs, `previousDistinct` and the before/after shapes behind contract tests (`shapesFor`) keep working. A shape that changed months ago still has its "before".
- **After each canary run,** the canary job prunes everything older than `OBSERVATION_RETENTION_DAYS` (default 30) and reports `pruned` in its log line.

## Verified

- `packages/db/test/db.test.ts` ("observation pruning"):
  - old repeats are deleted, including the newest old repeat when a newer row of the same shape exists;
  - the only observation of a shape is kept however old;
  - everything after the cutoff is kept, and other sources are untouched;
  - `previousDistinct` still finds the old shape, and pruning again deletes nothing.
- Typecheck, lint and the full test suite: results are in the PR.
