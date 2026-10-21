# M1-T4 api.lock format and writer

What exists: `packages/core/src/lockfile.ts` owns the contract: zod schemas for `Surface`, `CallSite` and `ApiLock` (the extractor now imports its types from core), `createApiLock()`, `serializeApiLock()`, `writeApiLock()`, and a JSON Schema export committed at `packages/core/schema/api-lock.schema.json` (a test keeps it in sync; `UPDATE_SCHEMA=1 pnpm test` regenerates it).
Format: `lockfileVersion: 1`, `generator`, `providers` (id, call-site count, SDK packages declared in package.json), `callSites` (12-hex `id`, file, line, column, provider, kind, client, operation, method, host, endpoint, resolved, surface).
How to run: `pnpm test packages/core` and `pnpm test packages/extractor` (the extractor fixtures round-trip through the schema).
Not done: the CLI `--out` flag that writes it lands in T1.7.
Decisions: deterministic by construction: sorted call sites and providers, keys in schema order, no timestamps or absolute paths, so the lock diffs cleanly in PRs. The id hashes file, line, column, method and endpoint, so moving a call changes its id; a position-independent id can come later.

```
pnpm test packages/core packages/extractor
```
