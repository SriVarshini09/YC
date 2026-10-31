# P-19: Claude Code on the leaderboard

## What

The APIBreak-Replay leaderboard had SHAPI and our own grep baseline. P-19 asks for at least one outside tool. This adds Claude Code (2.1.316, `claude-sonnet-5-5`): a general coding agent with no SHAPI inside, the way a team would check for an API change today without SHAPI.

## How it ran

- `packages/bench/scripts/claude-code.ts` (`bench:claude-code`) handles each of the 14 scored instances in its own E2B sandbox.
- The base commit and the fix commit are judged separately. Each is a codeload tarball with no git history, so the fix can't be seen from the base.
- Claude Code gets the advisory's public text and Read, Grep and Glob only. It has no shell and no network tools, and nothing from the repositories runs.
- The Vercel AI Gateway key goes only to the `claude` process. This is why the script uses E2B directly: SHAPI's own sandbox wrapper refuses keys by design (I-04).
- 28 runs cost about $0.90, below the $18 stop inside the $20 cap.
- Every answer is in `packages/bench/runs/claude-code-37fa931e8278.json`.

## Result

| Tool | Flag recall | Fixed-state precision |
|---|---|---|
| grep baseline | 100% (14/14) | 29% (4/14) |
| Claude Code | 57% (8/14) | 86% (12/14) |
| SHAPI 0.3.1 | 36% (5/14) | 93% (13/14) |

Claude Code catches more of the breakages than SHAPI 0.3.1.
- **GitHub workflow_dispatch:** it flagged 6 of 7.
- **QuickBooks minorversion:** it flagged 2 of 7.
- **False alarms:** it raised two on fixed code, on opaque-dev/opaque and tioperfumes07/IH35-TMS.

SHAPI stays the most precise, but its recall gap against a general agent is now on the record. The confidence intervals overlap at n = 14.
