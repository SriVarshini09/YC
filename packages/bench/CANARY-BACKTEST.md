# Canary back-test

Would SHAPI's canary have caught the API changes that broke integrations before it existed? This back-test (execution plan P-11) replays five incidents through the canary's own shape store, diff and draft classifier, one probe cycle at a time.

- **These are reconstructions.** The canary post-dates every incident, so each case in [`datasets/canary-backtest.json`](datasets/canary-backtest.json) is the response before and after the change, as a probe would have received it. Values are placeholders. For QuickBooks the field names are illustrative: what is tested is that the field set changes with no error status.
- **Expected:** the change class and severity of SHAPI's reviewed advisory for the case. There is no advisory for the Slack rate limit.
- **Cycles to see it:** probe cycles from the change to the first observation whose shape differs, with today's probes, and with the probe the case needs.

Run it again with `pnpm --filter @shapi/bench bench:canary-backtest` (offline).

<!-- table:start -->
One probe cycle is 60 minutes (the canary's default interval). Results: [results/canary-backtest.json](results/canary-backtest.json).

| Case | Expected (reviewed advisory) | Classified by the canary | Class matches | Severity matches | Probe today | Cycles to see it today | With the probe it needs |
|---|---|---|---|---|---|---|---|
| GitHub workflow_dispatch answers 200 with run details instead of 204 | status-code, critical | status-code, critical, breaking | yes | yes | `github:workflow-dispatch` | 1 (60 min) | 1 (60 min) |
| GitHub partially reverts: 204 again unless return_run_details is sent | status-code, critical | status-code, critical, breaking | yes | yes | `github:workflow-dispatch` | 1 (60 min) | 1 (60 min) |
| QuickBooks serves minorversion 75 fields to requests that ask for an older minorversion | version-sunset, high | field-rename, high, breaking | **no** | yes | none | no probe | 1 (60 min) |
| Reddit answers 403 to logged-out .json requests | auth, high | auth, critical, breaking | yes | no | none | no probe | 1 (60 min) |
| Slack rate-limits conversations.history for apps outside the Marketplace | rate-limit, high | none, - | **no** | no | none | no probe | 1 (60 min) |
<!-- table:end -->

## What it shows

- **GitHub workflow_dispatch: caught.** Both the 204 → 200 change and the partial revert are classified as critical status-code changes, matching the reviewed advisory. The `github:workflow-dispatch` probe sees each one cycle after it ships.
- **Reddit: classified, not probed.** The 403 is an auth change, as the reviewed advisory says. The canary rates it critical where the advisory says high. No Reddit probe exists yet; an anonymous GET of a public subreddit's `.json` would see it in one cycle.
- **Gap 1, QuickBooks old minorversion.** A probe that sends today's minorversion receives the new fields before and after the change, so it never sees it. A sandbox probe that sends `minorversion=65` would (CN-01).
  - The canary reads the evidence as a field change (`field-rename`). The reviewed advisory frames the same incident as a version sunset. Both are true; the advisory is the better description for a person.
- **Gap 2, Slack burst rate limit.** One request per cycle stays under the new limit, so the probe keeps seeing 200. A burst probe would see the 429 (CN-03), but that isn't enough on its own:
  - the diff treats 429 as availability, not contract (`informational: status 200 → 429`), so nothing is drafted;
  - SHAPI has no change class for rate limits.
  - Catching this needs the probe, a rule that a 429 at a low request rate is a contract change, and a change class.
