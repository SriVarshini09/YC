# PB-51: Contract-test stubs from recorded witnesses, and the PR says which (execution plan V-03)

## Why

A contract test is only an independent check when its fake provider answers with what the provider really sent, not with what SHAPI (or Claude) believes it sends. Otherwise the fix and its test share one belief. The PR also didn't say where the stub came from.

## What changes

- **`witnessToShape()` in `@shapi/shapes`.** It turns a shape witness (A-01) back into a response shape: status, a JSON content type for a JSON body, and every key path with its types and string format. A map gets one `key`, and values stay zeroed. The existing recorded-response test generator builds its stub from that.
- **Recorded responses are now witnesses.** The fix job's lookup of recorded responses (`shapesFor`) now builds the before and after shapes from the replayed recording's witnesses: the last response before the change and the latest one. It returns their `shape_id`s.
- **The test knows its stub.** `repairCallSite()` records the contract test's `kind` in its result:
  - `recorded`: the stub is the recorded responses;
  - `request` or `same-result`: the stub is built from the advisory's `fix`.
- **The PR says which.** Under "Contract tests" it now states either "**Stub:** from recorded responses (recording github-workflow-dispatch-204-to-200.json, witnesses `…` → `…`)" or "**Stub:** synthesized from the advisory (no recorded responses for this endpoint)".
- **Not yet.** Canary observations are still stored as shapes, not witnesses, so a stub from canary history keeps using shapes. The witness store with expiry (A-02) moves the canary onto witnesses.

## Verified

- **The plan's test, end to end:** in the worker's push → scan → fix → PR run, the GitHub 204→200 PR says its stub came from the recorded responses and names the two witnesses' ids, which match `fixtures/witnesses/github-workflow-dispatch-204-to-200.json`. The QuickBooks PR, built from its advisory's fix, says "synthesized from the advisory".
- **Unit tests:**
  - `witnessToShape()` rebuilds types, string formats, nullable fields, maps and an empty 204;
  - the PR body shows each stub line.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
