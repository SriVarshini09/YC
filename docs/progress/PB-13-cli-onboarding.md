# PB-13: CLI onboarding (a title, next steps, the `shapi-cli` command, never `npx shapi`)

## What a new user ran into

- **`npx shapi …` runs someone else's code.** The npm package named `shapi` isn't SHAPI ("My web api library for javascript"). The agent skill told coding agents to run `npx shapi scan <dir>` in any repository. The README and the drafts README used the same command; it only works inside this repository.
- **`shapi-cli` wasn't a command.** After `npm install -g shapi-cli` the command was only `shapi`, so typing the package name failed.
- **No way from the CLI to the product.** The CLI is local only and sends nothing to SHAPI, so CLI users have no dashboard. Nothing told them where the hosted service is.

## What changes

- **A title:** every `scan`, `fix` and `--help` run starts with `SHAPI  third-party API changes, caught and fixed` (bold and dim on a terminal). The scan header line is now `scan  <path>`.
- **Next steps** at the end of a scan:
  - `npx shapi-cli fix <same path or --repo url>`, when something is affected;
  - `https://app.shapi.dev`, to install the GitHub App for scans on every push, verified fix PRs and a dashboard.
- **After `fix`:** without `--write` or `--pr`, it says nothing was changed and how to keep the fixes. Every run ends with the app link. `--help` ends with the `npx shapi-cli` form and the app link.
- **Both command names:** the npm package (`build-npm.ts`) and the workspace package install both `shapi` and `shapi-cli`.
- **No more `npx shapi`:**
  - the agent skill says `npx shapi-cli`, and warns that `shapi` on npm is someone else's package;
  - the README and drafts README use `pnpm exec shapi`, which only runs the local build and never downloads;
  - the npm README mentions both command names.

## Not yet

- These changes reach users with the next npm release of `shapi-cli`, which needs the founder's npm sign-in.
- The homepage terminal sample (`site/.vitepress/theme/components/Home.vue`) shows 0.2.0's real output. Update it together with that release.

## Verified

- `packages/cli/test/cli.test.ts` checks the title, the `scan` line, the `Next` section's fix command and the app link.
- Typecheck, lint, the full test suite, and the npm package build (both bins) pass: results are in the PR.
