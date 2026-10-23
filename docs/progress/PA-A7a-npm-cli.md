# PA-A7a shapi-cli on npm

What exists: `packages/cli/scripts/build-npm.ts` builds the publishable **`shapi-cli`** package into `packages/cli/npm` (git-ignored). The plain name `shapi` and the `@shapi` scope belong to others on npm.
- SHAPI's workspace packages are bundled into one file (about 128 KB).
- Only the third-party packages the bundle imports become dependencies, read from the bundler's metafile, plus `vitest`, which `fix` resolves at runtime. That makes 11 in total.
- The reviewed advisories and the recordings ship inside the package.
- The CLI finds those folders whether it runs from the package or the monorepo (`bundledDir`). `@shapi/sandbox` is marked side-effect-free, so the CLI no longer pulls in E2B.
- `packages/cli/README.npm.md` becomes the package README.

`smoke-npm.ts` packs the package, installs the tarball into an empty folder, and runs it as a user would:
- `--version` works.
- `scan` finds the demo's GitHub breakage (exit 1).
- `scan --json` includes the api.lock.
- `fix` repairs it test-first with the recipe (exit 0).

A new CI job, `npm-package`, runs both scripts on every PR.

Verified: the smoke test passes locally, and 220 tests pass.
License: Apache-2.0, in `packages/cli/LICENSE`. It covers the package (the CLI and the libraries it bundles), not the rest of the repository; the build refuses to run without it.
Not done: publishing, which needs an npm account and `npm login`.

```
pnpm pack:cli
cd packages/cli/npm && npm publish --access public
```
