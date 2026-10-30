# PB-66: Canary back-test (execution plan P-11)

## Why

The canary is SHAPI's live evidence. Before relying on it, check what it would have made of the incidents that broke integrations, and which ones today's probes can't see.

## What changes

- **`datasets/canary-backtest.json`:** five reconstructed cases from §3.3, each with the response before and after the change:
  - GitHub workflow_dispatch 204 → 200, and the partial revert;
  - QuickBooks minorversion below 75 ignored;
  - Reddit logged-out `.json` 403;
  - Slack's non-Marketplace rate limit.
  - Expected classifications come from SHAPI's reviewed advisories.
- **`runBacktestCase()`** (`src/canary-backtest.ts`):
  - replays each case through the canary's `replay()`, `diffShapes` and draft classifier;
  - counts the probe cycles until the shape changes, with today's probes (a probe that receives the same response on both sides never sees it) and with the probe the case needs.
- **`pnpm --filter @shapi/bench bench:canary-backtest`** writes `results/canary-backtest.json` and `CANARY-BACKTEST.md`.
- **`@shapi/canary` and `@shapi/shapes`** move to bench's dependencies, since the back-test uses them at runtime.

## Results

| Case | Classified | Matches the reviewed advisory | Seen today |
| --- | --- | --- | --- |
| GitHub 204 → 200 | status-code, critical | yes | 1 cycle |
| GitHub partial revert | status-code, critical | yes | 1 cycle |
| Reddit 403 | auth, critical | class yes, severity no (high) | no probe |
| QuickBooks minorversion | field-rename, high | class no (version-sunset) | gap: needs an old-minorversion probe |
| Slack rate limit | nothing drafted | no | gap: needs a burst probe, a 429 rule and a rate-limit class |

## Verified

- **Unit tests** (`packages/bench/test/canary-backtest.test.ts`):
  - expected values match the reviewed advisories;
  - the GitHub, Reddit, QuickBooks and Slack outcomes;
  - a probe that receives the same response on both sides never sees the change.
- **Checks:** typecheck, lint and the bench tests pass. CI runs the full suite.
