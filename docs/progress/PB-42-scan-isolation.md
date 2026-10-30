# PB-42: A repository too large to scan fails alone (execution plan I-01)

## Why

One large repository (Nori) ran the 512 MB worker out of memory about every 30 minutes:

- every job on the worker died with it;
- the stuck-scan sweep then queued the same scan again, so the crash repeated.

## What changes

- **Its own process.** Each static scan runs in a child process, `apps/server/bin/scan-child.mjs`, started with `--max-old-space-size` (640 MB by default). If that child runs out of memory, only that scan fails.
- **Size gate.** Before scanning, the worker counts the bytes of TypeScript, JavaScript and Python source. Over 4 MB, the scan is refused with a message that gives both sizes. Other files don't count.
- **Time limit.** A scan that runs longer than 10 minutes is killed.
- **No crash loop.** A refused, out-of-memory or timed-out scan throws `ScanTooLargeError`:
  - the scan is marked failed, with the reason;
  - the SHAPI check completes as neutral and says why;
  - the sweep never sees it as stuck, so it isn't queued again.
- **Alert.** `ScanTooLargeError` is reported to Sentry.
- **Memory.** `fly.toml` gives the worker 1 GB; the web process stays at 512 MB.

Decision D8 in the plan: process isolation and a size gate now, Fly Machines per scan when volume needs them, and E2B kept for running fixes.

## Verified

- **Tests:**
  - a scan in a separate process returns the expected api.lock;
  - the size gate refuses a repository over the limit, and ignores files that aren't source;
  - a scan given a 24 MB heap runs out of memory and fails with `ScanTooLargeError`, and the next scan in the same process still works;
  - `runScanJob` on a too-large repository marks the scan failed, records the reason and puts it on the check run.
- **Full suite:** typecheck, lint and the full test suite.
