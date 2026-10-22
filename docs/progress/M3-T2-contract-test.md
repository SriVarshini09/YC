# M3-T2 contract test generation

What exists: `generateContractTest({ callSite, advisory, before, after, sourceText })` in `packages/repair/src/contract.ts`. It finds the exported function around the call site, builds arguments from its declared parameter types (strings, numbers, booleans, and same-file interfaces, type aliases and type literals expanded into objects), and writes `test/shapi/<advisory-id>.test.ts`: a vitest file that stubs `fetch` to return the before response, then the after response, and calls the function each time. `synthesizeBody(shape)` builds the response bodies from the stored shapes (every field path, values chosen from types and value classes; no real payload exists to copy). `runTestFile(dir, file)` runs it with the repo's own vitest, or SHAPI's when the repo has none.
How to run: `pnpm test packages/repair`. On `fixtures/demo-ts` the generated test fails on the current code (`deploy dispatch failed with 200`, 1 failed and 1 passed) and passes after the status-code recipe (2 passed).
Not done: call sites using axios, got or SDK clients (they need module mocks rather than a `fetch` stub; reported as unsupported with a reason); functions that are not exported; redacted shapes (no clear-text paths to synthesize from).
Decisions: the test asserts only that the function completes against both responses, which is the contract that broke. It does not assert return values, which would need knowledge the shapes don't hold.

```
pnpm test packages/repair
```
