# PB-21: deployment, tooling and docs fixes from the full review

## Why

Review 6 (deployment, tooling and docs) found a Docs workflow that still deployed to GitHub Pages, which is off, so it failed on every push to main and every day on its schedule. Since PB-12 the docs are built into the server image and served by Fly, so the landing page froze "today" at deploy time, and the legal pages still named GitHub as the docs host. The deploy workflow gave the Fly token to an action on a moving branch and did not wait for CI. Smaller items: stale demo output, a link to a PR outsiders can't open, a Node range wider than the dependencies allow, `GIT_SHA` set only at runtime, a Docker smoke test that skipped the docs host and the worker, and a typecheck that skipped the site and the scripts.

## What changes

- **Docs workflow:** it only builds the site now, on pull requests, on pushes to main and by hand, as a dead-link check. The Pages upload and deploy and the daily schedule are gone. It also runs when `advisories/` changes, because the site reads them.
- **Landing page dates:** `site/.vitepress/theme/dates.ts` counts days from a given "today". `Home.vue` renders the build date first, then switches to the visitor's date on mount. That keeps the ring's "in N days", "N still ahead" and the terminal's HubSpot deadline correct between deploys. The loader's build-time `upcoming` list is removed. The docs CSP needs no change, because the code ships in the site's own bundle (`script-src 'self'`).
- **Hosting wording:** the privacy policy says the docs are served by SHAPI's server on Fly.io, with request logs kept in Fly's log system. The subprocessors page lists the docs site under Fly. The comments in `site/.vitepress/config.ts`, `site/package.json` and the README no longer mention GitHub Pages.
- **Deploy workflow:**
  - It runs on `workflow_run` once CI succeeds on a push to main, and deploys the commit CI checked.
  - `FLY_API_TOKEN` is set only on the `flyctl deploy` step. The other steps see a true/false flag.
  - `setup-flyctl` is pinned to the 1.6 release commit.
  - CI fails if any workflow uses an action pinned to `master` or `main`.
- **Source repository wording:** nothing calls the YC repository private any more (`site/.vitepress/config.ts`, `build-npm.ts`, `docs/agents.md`). The npm README loads its logo from `https://shapi.dev/shapi-lockup.png` (new in `site/public/`), not from `raw.githubusercontent.com` in the YC repo. The repository's visibility is unchanged.
- **shapi-demo PR #2:** shapi-demo is not public, so the README and the app landing page (`apps/server/src/web/landing.ts`) now link to "What a fix PR contains" on shapi.dev. On the docs landing, the PR pane's title is no longer a URL.
- **Landing terminal:** the "Next" lines are the real ones from `packages/cli/src/report.ts`. A fresh `shapi scan .` on a clean copy of `fixtures/demo-ts` prints `4 files · 5 call sites · 4 providers`, which matches what the page shows. The review saw 5 files because its copy still held a generated test file.
- **Node:** engines are `^22.12.0 || ^24.0.0 || >=26.0.0`, matching commander 15 (`>=22.12.0`) and vitest 5. The quickstart, both READMEs and the root manifest say the same. The `npm-package` CI job builds on Node 24, then installs and runs the package on Node 22.12 and 24.
- **GIT_SHA:** the image bakes it in with `ARG GIT_SHA` / `ENV GIT_SHA`. The deploy workflow passes `--build-arg GIT_SHA=…`, and a runtime `flyctl deploy --env GIT_SHA=…` still overrides it.
- **Docker smoke test:** the image is built with the commit as `GIT_SHA`, and `/version` must report it. The web container runs with `SHAPI_DOCS_URL`/`SHAPI_DOCS_DIR`, and `/guide/cli` on host `shapi.dev` must serve the CLI reference. The worker must log "worker started" and still be running a few seconds later.
- **Typecheck:** it now covers `site/.vitepress/**/*.ts`, `site/test`, `packages/*/scripts` and `apps/*/scripts`.
  - `allowImportingTsExtensions` is on, for the scripts' `.ts` imports.
  - The site declares `vue` (its theme imports it).
  - A `*.vue` module shim is added.
- **Minor:**
  - The workspace package `shapi` is `private`; the published package is `shapi-cli` from `build-npm.ts`.
  - SKILL.md lists each tool's real arguments. It no longer sends users of other repositories to `pnpm canary run`.
  - `docs/agents.md` uses `<path-to-shapi>`.
  - The README layout lists `packages/db`, `packages/sandbox` and `apps/server`.
  - The quickstart covers Python, the "Exposed, not affected" section and what the deadline list includes.
  - "How it works" says three groups.

## Verified

- `site/test/dates.test.ts` (new, in the vitest include): a visit later than the build drops a change that took effect in between, and counts days from the visit.
- A built site in a browser: with `Date.now` moved to 2026-11-19, remounting the landing page changed "24 still ahead" to 20 and the HubSpot deadline from 36 days to 15. No console errors.
- `docs:build` passes. `node --experimental-strip-types packages/cli/scripts/smoke-npm.ts` passes on Node 24.
- Not run locally: the Docker smoke test (no Docker daemon here), the Node 22.12 matrix entry, and the deploy workflow.
- Typecheck and lint are clean, and `pnpm test` passes: 43 files, 297 tests.
