# M2-T3 canary workers and scheduler

What exists: `packages/canary` (`@shapi/canary`, bin `shapi-canary`). A worker turns the environment into probes (endpoint pattern plus concrete request). GitHub: four public probes that need no credentials (rate_limit, a repo, a repo's workflows, its runs), plus the workflow_dispatch probe once `SHAPI_GITHUB_TOKEN`, `SHAPI_CANARY_REPO` (owner/name) and `SHAPI_CANARY_WORKFLOW` point at a SHAPI-owned test repo. Stripe: balance, customers and payment intents in test mode via `SHAPI_STRIPE_TEST_KEY` (live keys are refused). `runOnce` fetches every probe, infers each shape with the provider salt, stores it, and reports which endpoints changed since the previous observation. `runEvery` repeats without overlap. CLI: `pnpm canary run --once`, `--interval <min>`, `--provider`, `--db`, and `pnpm canary status`.
How to run: `pnpm canary run --once` (writes `.shapi/shapes.db`, gitignored). Live check on 2026-10-21: the 4 GitHub public probes ran, and a second run reported all 4 unchanged.
Not done: the dispatch and Stripe probes have not run live, because there is no SHAPI test repo or Stripe test key yet. There is no hosted scheduler (it runs as a long-lived process for now).
Decisions: tests use a fake `fetch`, never the network. Network errors are reported per probe and nothing is stored for them. `SHAPI_SHAPE_SECRET` sets the hashing secret; without it a dev secret is used and a warning is printed.

```
pnpm canary run --once
pnpm canary status
```
