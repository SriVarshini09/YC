# APIBreak-Replay leaderboard

How well each tool flags real third-party API breakages before the human fix (flag recall), and stays quiet once the code is fixed (fixed-state precision). The instances are the scored ones in [APIBreak-Replay](METHODOLOGY.md), and every tool is scored the same way, from its own verdicts on them. Errors count against the tool: an instance it could not run is not a catch.

To add a tool, see [SUBMISSIONS.md](SUBMISSIONS.md).

<!-- leaderboard:start -->
| Tool | Version | Flag recall | Fixed-state precision | Errors | Submitted by | Run |
| --- | --- | --- | --- | --- | --- | --- |
| [grep baseline](https://github.com/SriVarshini09/YC/blob/main/packages/bench/scripts/baseline-grep.ts) | 1 | 100% (14/14, 95% CI 79–100%) | 29% (4/14, 95% CI 12–55%) | 0 | SHAPI maintainers | 2026-10-31 |
| [SHAPI](https://shapi.dev) | 0.3.1 | 36% (5/14, 95% CI 16–61%) | 93% (13/14, 95% CI 69–99%) | 0 | SHAPI maintainers | 2026-10-30 |
<!-- leaderboard:end -->

The table is written by `pnpm --filter @shapi/bench bench:leaderboard` from `submissions/*.json` and SHAPI's latest `bench:run` result, and CI fails when it is out of date or a submission doesn't cover exactly the scored instances.
