# PB-64: Recordings expire and are re-checked against the live API (execution plan A-02)

## Why

Contract tests are built from recorded responses (`fixtures/recordings/`). A recording is a claim about what the API sends. Nothing said when that claim was last checked, so a fix PR could rest on a stub the API no longer matches.

## What changes

- **`expiresIn`** on a recording: how long it is trusted without a check, in days (`"90d"`, the default).
- **`fixtureStatus()`** (`packages/canary`) compares an expired recording with SHAPI's latest canary observation of the endpoint, the way Hoverfly checks a simulation against the real service. Each recording is one of:
  - `fresh`: within its expiry;
  - `revalidated`: expired, and the canary saw the same shape as the recording's latest response;
  - `stale`: expired, and the canary saw a different shape, so contract tests built from it may no longer match the API;
  - `unchecked`: expired, and no canary has observed the endpoint since.
- **`fixtureStatuses()`** (`apps/server/src/jobs/shapes.ts`) replays each shipped recording with the server's shape secret and compares it with the Postgres shape store. The hashes are comparable because both use the same secret.
- **Dashboard:**
  - the API changes page gains a "Recorded responses" card with each recording, its date and its status;
  - an advisory whose recording is stale shows **stub stale** next to its fix.
  - The page still loads if the check fails.

## Verified

- **Unit tests** (`packages/canary/test/fixture.test.ts`):
  - the default and custom `expiresIn`, and bad values rejected;
  - fresh within expiry, whatever the canary says;
  - unchecked without a newer canary observation;
  - revalidated on the same shape, stale on a different one;
  - a shorter expiry.
- **Web test:** the GitHub dispatch recording on the API changes page goes from unchecked to revalidated (a canary observation with the same shape) to stale (a canary observation with a different status), and then the advisory shows "stub stale".
- **Checks:** typecheck, lint, and the canary and shapes tests pass. CI runs the full suite.
