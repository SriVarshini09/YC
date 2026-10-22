# M0-T1 scaffold

What exists: a pnpm workspace (`packages/*`) with a shared TypeScript base config (strict, ESM, bundler resolution), vitest at the root, ESLint flat config with typescript-eslint, `.gitignore`, `.gitattributes` (LF) and `.nvmrc`.
How to run: `pnpm install` then `pnpm test`, `pnpm lint`, `pnpm typecheck`. The suite is empty and passes (`passWithNoTests`).
Not done: no packages yet; they arrive in Milestone 1.
Decisions: TypeScript pinned to 5.9 (TS 7 lacks the JS compiler API that tsup's d.ts build and typescript-eslint need). Node 22+ required (developed on Node 24). `@shapi/*` imports resolve to package sources in tests and typecheck, to built `dist` at runtime. `prepare` builds all packages on install so the CLI bin works right after `pnpm install`. better-sqlite3 deferred to Milestone 2. `main` holds one empty initial commit because the remote was empty and PRs need a base.

```
pnpm install && pnpm test
```
