# "Fix on the way" only while a fix can still come

## Why

The launch smoke test (2026-10-30) found this in the signed-in web app. SriVarshini09/Nori's Meta Graph v21 problem said "Fix on the way" on the overview, the problem page and the Problems list. The fix job had already run on that scan and given up: `unsupported: the call site is not inside an exported function`. So no PR was ever coming.

The web app decided "on the way" from the advisory alone: a recipe exists, or Claude is on. It never knew what the fix job did, because the job's report was only logged.

## What changes

- **Migration 0019** adds `scans.fix_report`. A finished fix job stores `{ advisoryId, status, reason }` for each change it looked at.
- **The web app** (`queries.ts`, `overview.ts`, `pages.ts`) reads that outcome with each problem.
  - When the job made no fix, the problem moves from "on the way" to "Fix by hand", with the job's reason. That covers `unsupported`, `rejected`, `already-handled`, `no-fix`, `no-shapes`, `alert` and `unverified`.
  - A run that never reached the change (`not-attempted`, out of time) still counts as on the way.

## Verified

- **New web test:** with a stored `unsupported` outcome, each page shows it.
  - The overview says "SHAPI could not fix it: the call site is not inside an exported function".
  - The problem page says "SHAPI tried and made no fix for this code, so no PR is opened: …".
  - The Problems list says "fix by hand".
  - A `not-attempted` outcome is still "on the way".
- **The upgrade-rescan worker test** checks that the fix job's report is stored on the scan it ran on.
- **The db migration list test, and the web and cloud suites,** pass.

## Not done

- Scans fixed before this deploy have no stored report, so Nori's problem keeps saying "on the way" until its next scan and fix run. The worker rescans after each deploy, because the fix job ran on another build.
