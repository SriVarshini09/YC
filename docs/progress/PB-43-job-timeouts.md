# PB-43: Every job has a time limit, and a job that keeps failing lands in a dead-letter queue (execution plan I-02)

## Why

A job that hung, or kept failing, stayed out of sight:

- **Hung scans.** A scan job whose code download hung ignored pg-boss's time limit. Its queue on that worker stopped taking jobs, and the scan showed "running" on the dashboard for good.
- **Crash loops.** A scan left running by a dead worker sat for 30 minutes, then the sweep queued it again. A scan that crashed every time (Nori, before I-01) looped like that forever.
- **Lost failures.** A job that failed all its retries just disappeared, with no alert.

## What changes

- **A time limit on every queue.** Every queue now has an explicit `expireInSeconds`, including advisory sync, which had none. pg-boss fails an attempt that runs past its limit and aborts its `job.signal`.
- **Scans stop on time.**
  - A scan job stops itself after 14 minutes. The code download and the scan process are cut off.
  - The scan is marked failed with "SHAPI stopped this scan after 14 minutes: it took too long". The check completes as neutral with that reason, and Sentry is told.
  - The queue's expiry a minute later is the backstop.
- **Worker shutdown and worker death.**
  - On a deploy or a shutdown, the job's signal puts the scan back to queued for the job's retry.
  - The scan queue now has a 60-second heartbeat. A job whose worker died is retried within about a minute, and the retry takes over the scan the dead attempt left running.
- **Hung scans show on the next sweep.**
  - The sweep runs every 10 minutes. It now marks a scan still running 20 minutes after it started as failed ("SHAPI stopped this scan: it was still running after 20 minutes") and logs it for Sentry.
  - It no longer queues it again, so a scan that hangs cannot loop.
- **Dead-letter queue.**
  - Every queue sends a job that failed every attempt to `dead-letter`. Its worker logs the job (queue, attempts, last error) as an error, so Sentry alerts.
  - For a scan job, it also marks the scan failed: "SHAPI gave up on this scan after N attempts: …".
  - Dead-lettered jobs are kept for 30 days.

## Verified

- **Tests:**
  - **Hung download:** a scan whose code download never answers is stopped at its time limit. The scan row shows the reason and the check completes as neutral.
  - **Shutdown:** a worker shutting down mid-scan puts the scan back in the queue and rethrows, so pg-boss retries it.
  - **Retry takeover:** a retried job takes over a scan left running by a dead attempt; a first attempt does not.
  - **Sweep:** the sweep fails a scan running for 21 minutes once, leaves one running for 15 minutes alone, and never queues the failed one again.
  - **Dead-letter settling:** a dead scan job marks its scan failed with the last error; a finished scan and other queues' jobs are left as they are.
  - **Queue options:** every queue has a time limit and the dead-letter queue.
  - **End to end on pg-boss:** a scan job that fails its only attempt goes through the real dead-letter queue. Its scan shows "SHAPI gave up on this scan after 1 attempt: …", and the error is logged for Sentry.
- **Full suite:** typecheck, lint and the full test suite.
