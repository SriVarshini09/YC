# M3-T3 repair agent

What exists: `repairCallSite({ repoDir, advisory, callSite, before, after, recipes, llm })` in `packages/repair/src/agent.ts`. It works only in a sandbox copy of the repo (no `.git`, build output or dependencies; `node_modules` is linked so the repo's own test setup works) and is test-first: write the generated contract test and confirm it fails, apply the advisory's recipe and rerun, and if that doesn't pass, ask the LLM fixer and rerun. A change is kept only when the contract test passes; otherwise the result is `rejected` and the file is restored. The result lists the changed files (before and after text) plus the new test, every attempt with its test run, and the reason when nothing was kept. `already-handled` means the test passed before any change; `unsupported` means no test could be generated.
LLM fixer: `claudeFixer()` calls `claude-fable-5-1` (the model the plan names; `SHAPI_REPAIR_MODEL` overrides it) with the advisory, the call site, the file, the contract test and the failing output. It runs at effort `high` with server-side refusal fallbacks (`fallbacks: "default"`), and expects a strict `submit_fix` tool call carrying complete file contents. Refusals, text-only answers, schema mismatches and API errors become `declined` with a reason. The agent refuses LLM writes outside the repo, to the test, or into protected folders.
How to run: `pnpm test packages/repair` (the LLM paths use a stub; the Claude client is faked, so no key is needed).
Not done: a live Claude run (needs `ANTHROPIC_API_KEY` in your terminal); PR delivery (T3.4).
Decisions: the recipe always goes first because it is deterministic and free; the LLM only sees cases the recipe couldn't fix, and its output is never trusted without the test.

```
pnpm test packages/repair
```
