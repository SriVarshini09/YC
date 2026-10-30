# PB-53: The undo check: every part of a fix must be what its test checks (execution plan V-04)

## Why

A contract test that fails before a fix and passes after it proves the fix as a whole helps. It doesn't prove the test checks every part of the change. A fix that also edits something the test never exercises would pass all the same, and a reviewer would trust that part too.

## What changes

- **`packages/repair/src/undo.ts`: `checkUndo()`.** After a fix is kept, it splits the change into its parts (changed line ranges per file, from the longest common subsequence) and undoes each part on its own, with the rest of the fix in place. It runs the contract test each time and puts the fixed file back after every run.
  - **Passed:** every undo makes the test fail.
  - **Survived:** a part whose undo the test survives is named (`file:line`). The fix is kept, but a person has to check that part.
  - **Not run:** more than 6 parts (each costs a test run), a test that did not run, or no existing file changed.
- **`repairCallSite()`.** It runs the check on every kept fix, recipe or LLM, and returns `undo`.
- **PR body.** The contract-test section shows one of:
  - "**Undo check:** ✅ k/k: undoing any part of this change makes its contract test fail";
  - "⚠️ k/n: undoing `file:line` does not make the contract test fail … A person should check it (labelled `needs-human`)";
  - "⚪ not run: <reason>".
- **Label.** A fix with a surviving part opens its PR with the label `needs-human` beside `shapi`.

## Verified

- **Tests:**
  - **Parts:** a change splits into its two separate parts, each undone alone.
  - **Passed:** with a contract test that fails while the code accepts only 204, the real fix passes the undo check 1/1.
  - **Survived:** an LLM fix that also adds an unrelated constant is kept, but the check names `src/deploy.ts:5` as a surviving part (1/2).
  - **Not run:** too many parts, or a test that did not run. The fixed file is put back after each undo.
  - **PR body and label:** the body shows ✅, ⚠️ and ⚪, and a fix that asks for `needs-human` opens its PR with that label.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
