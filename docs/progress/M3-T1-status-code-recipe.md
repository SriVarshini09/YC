# M3-T1 recipe format and the status-code recipe

What exists: `packages/repair` (`@shapi/repair`). A recipe is a deterministic transform for one change class: `edits({ sourceFile, call, callSite, advisory })` returns text edits with a one-line note each. `runRecipe(RECIPES, advisory, callSite, text)` finds the call the api.lock points at (the innermost call at that line and column), runs the advisory's `recipeId`, and returns the before/after file text, or a reason (no-recipe, call-not-found, no-change). First recipe: `status-code-accept-set`. It follows the response status through the same dataflow the extractor uses (variable, destructuring, `.then`, in place) and rewrites `!==`/`===`/`!=`/`==` comparisons to `![200, 204].includes(res.status)`, adds missing `case` labels to a `switch`, and extends `[…].includes(status)` lists.
Advisory change: triggers gain `newStatusCodes` (the codes the provider sends now). The matcher no longer flags code that already compares against all of them, so a fixed call site drops out of the next scan. The GitHub seed has `newStatusCodes: [200]`; drafted status-code advisories now get `newStatusCodes` and `recipeId: "status-code-accept-set"`.
How to run: `pnpm test packages/repair`.
Not done: contract test (T3.2), sandboxed agent (T3.3), PR delivery (T3.4).
Decisions: edits are applied right to left on the original text, so formatting outside the changed expression stays byte-identical (a test checks this on `fixtures/demo-ts/src/deploy.ts`).

```
pnpm test packages/repair
```
