# PA-A7b public advisory database

What exists: **https://github.com/SriVarshini09/shapi-advisories**, public under CC BY 4.0 (GitHub detects the license). It is now the source of truth for advisories. It contains:
- the 7 reviewed advisories
- `schema/advisory.schema.json`, generated from SHAPI's `AdvisorySchema` (zod's `starts_with` was turned into a standard pattern)
- `scripts/validate.mjs`, which checks the schema plus a file name that matches the id, unique ids and `https` sources, run in CI on every PR
- a README with a table of the advisories, `CONTRIBUTING.md` with the evidence rules, and a PR template.

In this repository:
- `syncAdvisoriesFromGitHub` downloads the public repository's `advisories/*.json` with no token, validates each file, reports and skips bad ones, and refuses an empty result so stored advisories are kept.
- The worker uses it when `SHAPI_ADVISORIES_REPO` is set (`fly.toml` sets it): hourly (`ADVISORIES_SYNC_CRON`) and on start. The fan-out runs only when something changed.
- `pnpm advisories:pull` refreshes `advisories/` (bundled into `shapi-cli`) from the public repository, and the advisories README now points there.

Verified:
- The validator passes the 7 advisories and rejected a deliberately broken copy.
- The public repository's CI runs the validator.
- The pull script fetched the live repository; its 7 advisories were identical to these.
- 224 tests pass, 4 of them new: unauthenticated sync, unchanged files not rewritten, bad files skipped and reported, an empty repository refused, and config validation.

Not done: advisories deleted upstream are not yet removed from the database.

```
pnpm advisories:pull
SHAPI_ADVISORIES_REPO=SriVarshini09/shapi-advisories pnpm --filter @shapi/server dev
```
