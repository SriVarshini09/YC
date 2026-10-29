# PB-23: repair, sandbox and shapes review fixes

## Why

The full code review of 2026-10-29 (reviewer 4: packages/repair, packages/sandbox, packages/shapes) found fixes that passed their contract test but failed the customer's `tsc`, LLM changes that could make a test pass without fixing anything, contract tests that passed or failed for the wrong reason, and shape diffs that drafted false advisories. Reviewer 5's M6 found that every `shapi fix` run (dry runs too) left a full copy of the repository, `.env` included, in the temp folder.

## What changes

### Fixes have to type-check

- **The codemod emits code that compiles.** In TypeScript files `apply-fix` asks the type checker about the receiver:
  - a renamed field read on a type that doesn't declare the new name gets a cast: `((e as any).folderIdV2 ?? e.folderId)`;
  - a comparison with a renamed enum value on a union without it (Stripe's nullable `ui_mode`) becomes `(["embedded","embedded_page"] as unknown[]).includes(x)`, and an added switch case becomes `case "hosted_page" as string:`.
  - Types it can't see (an import from another file or package) count as unknown, so they are cast too. `any` receivers and JavaScript files keep the plain form.
- **Verification type-checks.** After the contract test passes, the agent runs `tsc --noEmit -p <nearest tsconfig.json> --pretty false` with the repository's own TypeScript (`Workspace.typecheck`, local and sandbox). It compares the errors with a run taken before the change. A change that adds an error is rejected, and the attempt says which error.
- If there is no tsconfig, TypeScript isn't installed, the config only references other projects, or tsc can't check, the fix is kept. `RepairResult.typecheck` then says "not type-checked: …" instead of claiming a check.
- The generated test file itself now compiles under `strict` without the `dom.iterable` lib.

### The LLM can only change source files (#2, #3, #10, #4)

- **Allowed:** source files (`.js`/`.ts` and variants).
- **Refused:** the contract tests (`test/shapi/**`, compared case-insensitively), `*.config.*`, `package.json`, `tsconfig.json`, setup files, `__mocks__`, `.d.ts`, `.github`, drive paths and anything with `:`.
- A passing run must have run tests. "No test files found" with exit 0 is a failure.
- LLM errors (a write to a folder, an SDK error) become a failed attempt instead of failing the whole fix job.
- **Rollback is exact:** a path given twice keeps its last content, files are restored last-first, and created files are deleted (`Workspace.remove`).

### Contract tests prove the right thing (#5, #7, #8, #9)

- The generated tests mark the failure the advisory predicts with "SHAPI breakage":
  - the retired request was sent;
  - the new response threw or returned something else;
  - the new recorded response failed after the old one passed.
- The agent accepts a failing baseline only with that mark. Otherwise the result is `unsupported` with the real error. Before, a crash on the generated arguments or a missing import went to the recipe or to Claude.
- A rename test on a function that returns nothing is `unsupported` ("returns nothing, so there is no result to compare"), not `already-handled`. For recorded-response tests, "already handled" now says that the test checks that the code runs, not what it returns.
- Default exports are imported as the default, and `export { f as g }` as `g`.
- When the repository has a vitest or vite config, the test runs with `test/shapi/vitest.config.mjs`. That file spreads the repository's config (aliases, plugins, setup files) and sets `include` to SHAPI's tests, with no `exclude`, `dir` or `projects`. "No test files found" is now reported as the reason a run failed.

### Codemod correctness (#6, #14, #15, minor)

- Field renames only rewrite receivers that are safe to evaluate twice. `(await axios.get(url)).data.folderId` is left alone, because the fallback would send the request again.
- Writes are never rewritten: `+=`, `??=`, `++`/`--`, `delete`, destructuring targets and `for…of`/`in` heads.
- The status-code recipe resolves symbols, so a shadowing `(res) => res.status === 204` in a callback is left alone.
- A renamed field inside a renamed-value comparison is rewritten once, inside the comparison, not as two overlapping edits.
- A query fix never lowers a value at or above the trigger's `below` (a `minorversion=80` in a shared base URL stays).
- Every matching field rename applies to a test path, not only the first.
- Newlines in the advisory title or endpoint no longer break the generated file's header comment.

### The combined change is tested (#12)

With several fixed call sites, `repairAdvisory` runs every site's test again on the final code. A site whose test now fails is `rejected` ("its contract test fails on the combined change of all the call sites"). The change still holds every source edit, so the PR is exactly the tree that was tested.

### Workspaces and sandboxes (#11, #13, #16, #17, M6)

- **`localWorkspace(dir).dispose()`** deletes the temp copy. `shapi fix` (and so the MCP `apply_fix`) calls it after each advisory's repair, dry runs included. Only `.git` and `node_modules` are skipped at every depth. Nested `node_modules` are linked like the root one, and `dist`, `coverage` and `.shapi` are skipped only at the root.
- Local test and tsc runs get a minimal environment (`PATH`, temp and home folders, `SystemRoot`/`ComSpec` on Windows). The caller's `ANTHROPIC_API_KEY`, GitHub tokens and other secrets are not passed.
- **`Sandbox.extend(ms)`:** a sandbox starts with 15 minutes. Before each install, test run, type-check or delete, the workspace extends it to cover that command plus 2 minutes, up to 60 minutes from creation (`MAX_SANDBOX_LIFETIME_MS`, E2B's Hobby limit). Past that, `extend` throws "the sandbox reached its 60-minute lifetime limit…", instead of a command failing on a destroyed VM.
- `readSnapshot` never leaves out `package.json` or a lockfile for its size (`SNAPSHOT_KEEP`).
- `withSandboxWorkspace` no longer lets a failing `close()` hide the error that ended the work.

### LLM spend (#18)

- `withCallBudget(llm, max)` declines every call after `max`. The fix job and each `shapi fix --llm` run wrap their fixer in it. The default is `DEFAULT_LLM_CALLS_PER_JOB = 20`, and `SHAPI_LLM_CALLS_PER_JOB` overrides it.
- `claudeFixer` declines files over 200 kB (`MAX_LLM_FILE_BYTES`) without calling the API. The model has to return the whole file, so a window around the call site wouldn't work.

### Shape diffs (#19 to #22, minor)

- `integer` and `number` are the same JSON type in `diffShapes`, so 10 → 10.5 is no longer a breaking type change.
- An array that comes back empty (`items: []`, or a root `[]`) no longer reports its items' fields as removed.
- Keys holding `.`, `[` or `\` are escaped in field paths (`a\.b`, `filter\[name]`). `pathSegments()` parses them, and `synthesizeBody` uses it, so it no longer crashes on `[`.
  - Only paths with such keys change their hash. They show up once as a removed and an added field.
- `inferShape` stops descending at depth 64 (`MAX_DEPTH`) instead of overflowing the stack.
- `shapeHash` sorts header names, so a shape read back from JSONB hashes the same.

### Docs

- **`site/guide/fixes.md`:** the checks a fix has to pass (breakage mark, type-check, the source-only rule for Claude, the call budget, re-running combined changes, the vitest config), and the sandbox lifetime.
- **`security.md`, `guide/cli.md`, `faq.md`:** the type-check, the call cap, and the CLI's temp copy and minimal environment.
- **`legal/dpa.md` and `legal/subprocessors.md`:** the VM lives at most 60 minutes, not 15.

## Verified

- New tests:
  - `agent.test.ts`:
    - the LLM write rules, including other letter cases;
    - a "no tests" run is not a pass;
    - exact rollback;
    - a failing write or a throwing fixer is a rejected attempt;
    - a baseline that fails for another reason;
    - a type-checked recipe fix;
    - a change rejected for a new TS2322;
    - "not type-checked" without a tsconfig;
    - a default export;
    - a crash on the generated arguments;
    - a repo vitest `include`;
    - the combined-change re-run;
    - `dispose()` and nested `node_modules`/`dist`;
    - no tokens in the test environment;
    - the call budget and the file-size cap;
    - "No test files found" as the failure reason.
  - `apply-fix.test.ts`: `tsc --strict` on the codemod output (a typed field read, a nullable union with `===` and `switch`, a Stripe SDK type from a `.d.ts`, the HubSpot pipelines fix), writes and side-effect receivers, the field and enum overlap, query thresholds, and a void function being `unsupported`.
  - `contract.test.ts`: generated tests of all three kinds compile under `tsc --strict`, the header with a newline, an aliased export, two renames on one path, escaped keys in `synthesizeBody`.
  - `recipe.test.ts`: shadowing.
  - `workspace.test.ts`: `extend` before every command, the SHAPI vitest config, `remove`, sandbox `typecheck`, and close failures not masking errors.
  - `sandbox.test.ts`: the lockfile kept, and the lifetime cap.
  - `shapes/test/*`: integer/number, empty arrays, dotted and bracketed keys, depth, and header order in the hash.
  - `cli/test/fix.test.ts`: the temp copy is gone after a dry run.
- Typecheck and lint are clean, and `pnpm test` passes.
