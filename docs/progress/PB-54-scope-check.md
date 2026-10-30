# PB-54: The scope check: an LLM fix outside the predicted lines opens as a draft (execution plan V-05)

## Why

The contract test, the repository's tests, the typecheck, V-06 and the undo check all judge what a fix does to the affected call. None of them asks whether the LLM also edited code nothing predicted: a helper file, module-level code, another function. Such an edit may be right, but a reviewer should look at it on purpose, not find it by accident.

## What changes

- **`packages/repair/src/scope.ts`: `checkScope()`.** The predicted lines are the outermost function that contains the call, the one the contract test calls, or 10 lines either side at module level.
  - **LLM fix:** in scope only when every edit stays inside those lines. An edit to another file is listed as the file; an edit to other lines of the same file as `file:line`.
  - **Deterministic recipe:** in scope by construction, since it edits only the code it names.
- **`changedRanges()` in `undo.ts`.** It's exported, so the scope check reads the same changed regions the undo check undoes.
- **`repairCallSite()`.** It returns `scope` for every kept fix.
- **PR body.** "**Scope:** ✅ every edit is inside the function that makes the call", or "⚠️ the change also edits `src/helper.ts`, outside the function that makes the call. This PR is a draft for a person to check (labelled `needs-human`)".
- **Delivery.** An out-of-scope fix opens its PR as a draft with the `needs-human` label (also used by V-04). A repository that refuses drafts (a private repository on GitHub's free plan answers 422) gets a normal PR with the label.

## Verified

- **Tests:**
  - **The plan's case:** an LLM fix that also writes `src/helper.ts` is kept but out of scope (`src/helper.ts`).
  - **Same-file edit:** a fix that edits the module-level constant on line 3 is out of scope (`src/deploy.ts:3`, "outside triggerDeploy()").
  - **In scope:** the plain fix inside `triggerDeploy()` (lines 12-25) and the deterministic recipe.
  - **PR body:** the line shows ✅, ⚠️ and ⚪.
  - **Delivery:** an out-of-scope fix opens a draft labelled `shapi` and `needs-human`. Where the fake GitHub refuses drafts, it opens a normal PR with the same labels.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
