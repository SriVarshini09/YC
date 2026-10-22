# M2-T5 replay of the GitHub incident

What exists: `fixtures/recordings/github-workflow-dispatch-204-to-200.json`, a recorded sequence for `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`: two 204 No Content responses on 2025-12-18, then a 200 with a JSON body on 2025-12-19. `replay(recording, store, secret)` in `packages/canary/src/replay.ts` pushes each response through the same path a live canary uses (infer shape, store with source "replay", previous-distinct lookup, diff). `pnpm canary replay <file>` prints the result: breaking `status-code` 204 → 200, body empty → json, and content-type added (both informational).
How to run: `pnpm canary replay fixtures/recordings/github-workflow-dispatch-204-to-200.json`.
Not done: the draft advisory (T2.6).
Decisions: the recording is a reconstruction, not captured traffic. Statuses and dates follow the Stategraph write-up; the 200 body uses the three fields GitHub documents for this endpoint today (`workflow_run_id`, `run_url`, `html_url`) with placeholder values. The note and sources inside the file say so. The two 204s have different rate-limit and date headers and still hash to one shape, which is what keeps a live canary quiet between real changes.

```
pnpm canary replay fixtures/recordings/github-workflow-dispatch-204-to-200.json
```
