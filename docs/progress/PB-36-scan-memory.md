# PB-36: Scans use 40% less memory

## Why

Installing the GitHub App on Nori, a 347-file TypeScript monorepo with 2.1 MB of source, crashed the production worker. The log said `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`. The worker machine has 512 MB.

The worker restarted, but Nori's scan stayed "running". Every later push to Nori was skipped as "a scan is already pending", and each retry of the stuck scan ran the worker out of memory again. Other repositories' jobs died with it.

Measured locally on Nori:

- **The whole scan:** peak heap 518 MB, and 256 MB was not enough.
- **Parsing every file with ts-morph:** 113 MB.
- **What took the rest:** ts-morph's `getDescendants()` and `getDescendantsOfKind()` go through the compiler's `getChildren()`.
  - `getChildren()` builds and keeps a node for every token of a file: each bracket, comma and keyword.
  - For Nori that's 722,000 nodes against 385,000 real ones.
  - The bare-URL pass (`looseUrlSites`) wrapped every node with `getDescendants()` and added about 190 MB on its own.

## What changes

- **New helper:** `descendantsOfKind(node, ...kinds)` in `packages/extractor/src/walk.ts` walks with `forEachDescendant()`, which uses `forEachChild()` and builds no token nodes.
- **All 12 uses replaced:** every `getDescendantsOfKind()` in `callsites.ts` and `surface.ts`, and the `getDescendants()` in `looseUrlSites`, now go through the helper.

## Verified

- **Nori:**
  - Peak heap went from 518 MB to 304 MB, and the scan time from 3.0 s to 1.7 s.
  - It now completes under a 256 MB heap limit.
- **Same results:** the call sites are byte-for-byte the same on Nori, chief, agentops, fitmate-ai and shapi-demo, 56 records including every surface.
- **New test:** `packages/extractor/test/memory.test.ts` fails if a scan calls any of ts-morph's token-building methods. It fails on main and passes with the change.
- **Full suite:** typecheck and lint are clean, and the full suite passes (54 files, 493 tests).

## Not done here

- **Isolating each scan:** a repository several times Nori's size can still exceed the worker's heap and take the worker down with it. The scan should run where it can fail alone, for example a worker thread with `resourceLimits`, and report "too large" on the check run.
- **Worker memory:** the worker machine has 512 MB. Raising it to 1 GB is an operations change, not part of this PR.
