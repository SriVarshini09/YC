# M2-T2 shape store

What exists: `ShapeStore` in `packages/shapes/src/store.ts`, on better-sqlite3. One table, `observations` (provider, method, endpoint, observed_at, source, shape_hash, shape_json), indexed by endpoint and time. API: `ShapeStore.open(file | ":memory:")` (creates the folder and migrates via `user_version`), `record(observation)` (validates the shape and computes its structural hash), `history(provider, method, endpoint, limit)` (newest first), `latest(...)`, `previousDistinct(...)` (the last shape before the current one, the "before" side of a change), `endpoints()` (observation and distinct-shape counts per endpoint), `close()`.
How to run: `pnpm test packages/shapes`.
Not done: retention and compaction (every observation is kept); Postgres.
Decisions: file stores use WAL mode. `.shapi/` (the default store location the canary will use) is gitignored. better-sqlite3 13 has no prebuilt binary for Node 24 on Windows, so it compiles on install; that needs Python and the Visual Studio C++ build tools, both present on this machine. `allowBuilds` in `pnpm-workspace.yaml` now allows its install script.

```
pnpm test packages/shapes
```
