# PB-95: An opt-in traffic sensor for Node and Python (execution plan F-01)

## What changes

- **`@shapi/sensor` (Node)** wraps `fetch`, and **`shapi_sensor` (Python)** wraps `requests` and `httpx`, sync and async, with the standard library only.
  - For each response from an endpoint a SHAPI advisory names, they record the value-free shape: status, field names and JSON types, and the version and deprecation headers. Requests to anything else are not read.
  - Each endpoint is reported under the advisory's pattern, never the request's own path.
  - Identical responses are counted in memory and sent once a minute.
  - `dryRun` / `dry_run=True` prints each batch instead of sending it.
  - Both write the same wire format (`shapi.sensor/v1`) from the same endpoint list (`endpoints.json`, generated from the advisories).
- **Server:**
  - **Token:** a per-account sensor token (migration 0018, the hash only, row-level security), created and revoked in Settings.
  - **Upload:** `POST /api/v1/sensor/observations` stores each account's shapes as observations of its own source, salted like the canary's. It drops endpoints the sensor doesn't watch.
  - **Counting:** `sensorChanges` counts a change only when **3 or more accounts** saw the same change on the same endpoint, and marks it confirmed when the canary saw it too.
  - **Each canary run** reports how many sensor changes are counted and confirmed.
- **Docs:** `/guide/sensor` covers what is and isn't sent, dry run, and turning it on.

## Not done

- **Not published.** The sensor isn't on npm or PyPI yet; publishing is the founder's call. Until then it is installed from the repository.
- **Counted changes are not drafted as advisories yet.** They are counted, confirmed and logged.

## Verified

- **`apps/server/test/sensor.test.ts`, end to end:** three accounts' processes call GitHub's workflow_dispatch through the Node sensor.
  - **Before the change**, each upload carries one observation (`count: 2`, status 204, empty body). The uploads contain no owner, repository, run id, URL, or the unwatched API's values.
  - **After GitHub's change to 200** with the run's ids, two accounts aren't enough to count. The third makes it count: "status 204 → 200", 3 accounts, not yet confirmed.
  - **Once the canary** records the same change from its own probe, the change is confirmed by `canary:github:token`. This is `github-workflow-dispatch-204-to-200`, the change the plan's test asks for.
  - **Tokens:** an upload without a valid token gets 401, one that isn't a v1 batch gets 400, an unwatched endpoint is dropped and nothing is stored, and a revoked token gets 401.
- **`packages/sensor/test/sensor.test.ts`:**
  - endpoint matching (method, host, pattern) works;
  - the endpoint list matches the advisories, and the Python copy matches the Node one;
  - shapes hold field names and types only;
  - dry run prints the batch and sends nothing;
  - a token is required otherwise;
  - the Python sensor writes the same shapes as the Node sensor for the same bodies and matches the same endpoints.
