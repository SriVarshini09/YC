# PB-9 launch fixes: retries, the Claude option, docs claims, legal banners

These come from the pre-launch audit on 2026-10-27.

## Fixes are retried after an upgrade

**Before:** a fix job ran only after a scan or after an advisory changed. A fix that an older build couldn't make waited for the next push to the repository. For example, the live app never opened the HubSpot pipelines PR on shapi-demo, although the current build fixes it.

**Now:**
- Migration `0010_scans_fix_engine` adds `scans.fix_engine`, the git sha of the build that last finished a fix job on that scan.
- On start, the worker queues a `fix-retry` job. `scansToRefix()` returns each enabled repository's latest successful scan whose fix job ran on another build, or never ran. It returns a scan only if it has an affected call site with no fix PR yet that this build may fix: the call site has a recipe, or the account opted in to Claude and the worker has a key.
- Those scans get a fix job. PRs that already exist are left alone, closed ones included.
- A failed run doesn't record the build, so the job (or the next deploy) tries again.

## Dashboard ticks and resuming act right away

**Before:** ticking "open now" or "open again", or lifting the pause on the dashboard issue, only saved the intent until the next delivery run. Resuming from the web app worked the same way.

**Now:**
- `processDelivery` returns `fixes`, and the worker queues a fix job on the repository's latest successful scan when a tick asks for a PR or lifts the pause.
- The web app's Resume button does the same through a new `enqueueFix` on the web process's job sender.
- If the queue is down, the pause or resume is still saved, and the next scan delivers the fixes.

## The Claude option needs a key

Settings shows *Use Claude when no deterministic recipe fits* only when the server has `ANTHROPIC_API_KEY`. Without a key, saving the form keeps the account's saved choice instead of reading the missing box as unticked. `ANTHROPIC_API_KEY` is now part of the config schema.

## Docs say what's true

- **Docs landing page (`site/index.md`):** fixes happen where a recipe exists, for TypeScript and JavaScript. Other call sites get the provider's migration steps, and a "Watch" PR only where a recipe fits.
- **README:** "Fix it" says the same. The layout section no longer says "GitHub App later", and says Postgres is used for the hosted service.
- **Quickstart:** the fix steps apply to call sites with a recipe; the others, and all Python call sites, are reported.
- **How it works:** canaries use SHAPI's own test accounts, never your keys. Recordings are described as they are used (when an advisory's fix doesn't describe the change by itself).
- **Security and Fixes guides:** the Claude setting appears only when Claude is enabled on the server.

## Legal pages

- **Banners:** the four draft banners said the pages "take effect when the SHAPI GitHub App opens to the public". The App is public, so they now say the pages apply to early access, open to everyone now, are not reviewed by a lawyer yet, and may change before general availability. All are dated October 27, 2026.
- **Subprocessors:** the list names **Neon** as the Postgres host.

## Tests on Windows

The embedded test Postgres can hold its data folder for a moment after it stops (EBUSY). Cleanup now retries, then leaves the folder in temp, instead of failing test files whose tests all passed.

## Verified

New tests:
- `cloud.test.ts` ("fixes after an upgrade"):
  - a scan is due until this build runs it;
  - a waiting fix is due again on the next build;
  - with a PR for every fixable finding (a closed one counts), no scan is due;
  - findings without a recipe are due only with an opted-in account and a key.
- `fixes.test.ts`: "open now" queues a fix job on the latest scan; pausing doesn't; lifting the pause does.
- `web.test.ts`:
  - Resume queues a fix job, and Pause doesn't;
  - the Claude box appears only with a key;
  - saving without a key keeps the saved choice.
- `db.test.ts`: the migration list includes `0010_scans_fix_engine`.

Full checks: typecheck, lint, every test file, and the docs site build. Results are in the PR.

## Still open

These are on the founder's side:
- a lawyer's review of the legal pages;
- Stripe;
- canary keys;
- `ANTHROPIC_API_KEY` on Fly, if hosted Claude fixes should be offered;
- `SENTRY_DSN`;
- `FLY_API_TOKEN`;
- a decision on whether finding-page diffs should be visible per repository.

After this merges and deploys, the worker's first start queues the retry. The HubSpot PR on shapi-demo should then open (or wait for the hourly limit).
