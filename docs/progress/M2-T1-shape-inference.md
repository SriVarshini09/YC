# M2-T1 shape inference

What exists: `packages/shapes` (`@shapi/shapes`). `inferShape({ status, headers, body }, { salt })` turns one HTTP response into a shape: status code; contract headers with their values (`content-type` media type, `deprecation`, `sunset`, API-version headers); other non-volatile header names; body kind (empty, json, text); and per field path (`workflow_runs[].conclusion`) the JSON types, value classes (datetime, date, uuid, url, email, id, token, text, positive/negative/zero, true/false), occurrences, null rate, array length range, and for enum-like token fields the HMACs of distinct values (up to 50). `shapeHash()` hashes only the structure, so counts, lengths and rates don't change it. `redactShape()` drops clear-text paths. `providerSalt(provider, secret)` derives the per-provider salt.
How to run: `pnpm test packages/shapes`.
Not done: storage (T2.2), diff (T2.4).
Decisions: payload values are never stored: they are classified or HMAC'd with the provider salt (a test asserts no raw value appears in the shape). Clear-text paths are kept for SHAPI-owned canary traffic and removed with `redactShape` for tenant traffic. Volatile headers (date, etag, request ids, rate-limit counters) are dropped so they don't trigger diffs.

```
pnpm test packages/shapes
```
