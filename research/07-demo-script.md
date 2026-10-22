# Demo video script (60–90 seconds)

Record the screen at 1080p with the terminal font at 18pt or larger. Narrate live or add a voice-over.

## Before recording

1. Close any open SHAPI PR on `SriVarshini09/shapi-demo` (`gh pr close <n> -R SriVarshini09/shapi-demo --delete-branch`); otherwise `shapi fix --pr` stops on the existing branch.
2. In the SHAPI folder, run `pnpm install` once, then `cls` to clear the screen.
3. Open https://github.com/SriVarshini09/shapi-demo in a browser tab.

## Shots

| # | Time | On screen | Say |
|---|---|---|---|
| 1 | 0:00–0:10 | GitHub's docs page for "Create a workflow dispatch event" | "In December, GitHub's workflow_dispatch API started answering 200 instead of 204. No changelog, and the spec still said 204. Code that checked for 204 broke." |
| 2 | 0:10–0:25 | `npx shapi scan fixtures/demo-ts` | "SHAPI scans a repo in about a second. It knows this call site compares the status to 204, and that GitHub changed it." Point at `CRITICAL src/deploy.ts:13`. |
| 3 | 0:25–0:35 | `pnpm canary replay fixtures/recordings/github-workflow-dispatch-204-to-200.json` | "Our canaries record response shapes, never data. When the shape changes, SHAPI writes the advisory itself." Point at `breaking status-code 204 → 200`. |
| 4 | 0:35–0:55 | `npx shapi fix --repo https://github.com/SriVarshini09/shapi-demo --pr` | "To fix it, SHAPI generates a contract test from the old and new responses, checks that it fails, applies the fix, and keeps it only if the test passes. Then it opens the PR." |
| 5 | 0:55–1:10 | The new PR on GitHub: the one-line diff, the test file, the evidence table, CI green | "One line changed, a test that guards it, and the evidence. CI is green." |
| 6 | 1:10–1:25 | Claude Code with the `shapi` tools: ask "Use SHAPI to check fixtures/demo-ts for API breakages" | "And it works inside coding agents: Claude Code runs the same loop through SHAPI's MCP server." |
| 7 | 1:25–1:30 | Title card | "SHAPI: APIs change. Your code keeps up." |

## Notes

- Shot 4 takes about 6 seconds. Keep it in real time, because the speed is part of the point.
- Shot 6 is optional if the video runs long.
- Don't show API keys or tokens on screen. Set them before recording and clear the terminal.
