# PB-9b: after an upgrade, scan again instead of reusing the old api.lock

## What happened after PB-9 deployed

PB-9 (v11, `da405a7`) retried fixes after an upgrade, and the retry ran as designed on shapi-demo:
- worker log: `fixes queued again for this build`, 1 scan;
- the QuickBooks PR (#9) was re-verified;
- HubSpot came back `rejected: no change made the contract test pass`, and went to "Needs a manual fix" on the dashboard.

## Why

The HubSpot call site reads the response through an array callback:

```ts
resp.data.results.flatMap((p) => p.stages)
```

The extractor learned to follow such callbacks in PB-2 (`fbbc01b`, 2026-10-23 13:21). shapi-demo's stored `api.lock` comes from a scan that ran before that was deployed. Advisory fan-outs since then only re-matched that lock; they never mapped the code again.

So the old lock doesn't record that the code reads `results[].stages`. The contract test built its fake response from it and left `results` out. Even the fixed code then threw, so the recipe was rejected.

## How it was ruled in

- The published CLI fixes it locally, with and without `node_modules`.
- The server's own repair path (snapshot, install, `repairAdvisory`) fixes it with a fresh lock in a local sandbox and in a real E2B sandbox.
- Repairing QuickBooks first in the same workspace doesn't change the result.
- The synced advisory is identical to the one in this repository.

The only remaining difference was the stored lock.

## The change

The worker's `fix-retry` job now queues a **fresh scan** of each repository that `scansToRefix()` returns (`{ repositoryId }`, which scans the default branch head), instead of a fix job on the old scan. That scan maps the code with this build's extractor, and it queues the fix job as every scan with affected call sites does. The fix job records the build on the new scan.

Selection is unchanged: only repositories with a fixable affected call site that has no PR yet, once per build.

## Verified

- New worker test in `cloud.test.ts`: a scan from an "old-build" makes a worker started as "new-build" scan the repository again. The fix job runs on the new scan, which gets `fix_engine: "new-build"` while the old scan keeps its value, and the PRs open.
- Typecheck, lint and the full test suite: results are in the PR.
