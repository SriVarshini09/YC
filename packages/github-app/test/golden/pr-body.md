**GitHub: workflow_dispatch returns 200 with a body instead of 204. It took effect on 2025-12-19, 315 days ago.**

In this repository it affects 1 call site; SHAPI fixed it here. POST .../actions/workflows/{workflow_id}/dispatches started answering 200 OK with a JSON body (workflow run id) instead of 204 No Content. The OpenAPI schema and docs still said 204, and there was no changelog, version, or preview header. Clients that require exactly 204 treat a successful dispatch as a failure. GitHub later (2026-02-19) documented 200 as the response when return_run_details is set, and GitHub CLI v2.87.0+ sets it by default.

| Call | Before | After | Where |
|---|---|---|---|
| ` POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches ` | ` if (res.status !== 204) { ` | ` if (![200, 204].includes(res.status)) { ` | ` src/deploy.ts:13 ` |

`Size: +1 −1 in 1 file · Tier: Review · Confidence: high`

**Checked:** ✅ contract test (failed before, passes after) · ✅ your tests 12 passed · ✅ undo check 1/1 · ✅ scope · ✅ type check

**Could change:** code that reaches this endpoint in a way SHAPI cannot read (a URL built elsewhere, a value from configuration) is not covered; see Not changed below.

<details><summary>What GitHub announced</summary>

GitHub published no notice: this change was found from its behavior.

The summary above is SHAPI's, not GitHub's words.

</details>

<details><summary>Affected call sites (1 of 1 fixed here)</summary>

- [x] ` src/deploy.ts:13 ` (` POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches `): fixed, test `test/shapi/github-workflow-dispatch-204-to-200.test.ts`

</details>

<details><summary>Change and checks (deterministic recipe `status-code-accept-set`)</summary>

- `src/deploy.ts:3` accepts 200 as well as 204

Each contract test calls the code with the response it was written for and the one the provider sends now. Each failed before this change and passes after it. A change that adds type errors is not kept.

**Stub:** from recorded responses (recording github-workflow-dispatch-204-to-200.json, witnesses `c3e1c3e1c3e1` → `2e7b2e7b2e7b`).

**Undo check:** ✅ 1/1: undoing any part of this change makes its contract test fail.

**Scope:** ✅ every edit is inside the function that makes the call.

| Test | Before this change | After this change | Type check |
|---|---|---|---|
| `test/shapi/github-workflow-dispatch-204-to-200.test.ts` | fail (1 failed \| 1 passed) | pass (2 passed) | pass: ` tsc --noEmit -p tsconfig.json: no new errors ` |

**Your tests:** ✅ ` npm test ` passes with this change (before: ` 12 passed `; after: ` 12 passed `).

</details>

<details><summary>Evidence</summary>

| | |
|---|---|
| Advisory | `github-workflow-dispatch-204-to-200` (verified) |
| Severity | critical |
| Change class | status-code |
| First observed | 2025-12-19 |
| Provider notice | none (undocumented change) |
| Shapes from | recording github-workflow-dispatch-204-to-200.json |
| Blast radius | 1 affected call site in this repo |
| Sources | [1](https://stategraph.com/blog/github-broke-the-contract) [2](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids) |

Migration note: Treat both 200 and 204 as success (any 2xx). If you want the run id, send return_run_details: true and read it from the 200 body.

</details>

<details><summary>Not changed (1)</summary>

- ` src/status.ts:8 ` (` GET /repos/{owner}/{repo}/actions/runs `): ` calls GET /repos/{owner}/{repo}/actions/runs but does not depend on the changed behavior `

</details>

Was this pull request useful? [👍 Yes](https://app.shapi.dev/feedback?t=eyJyIjoiMiIsImEiOiJnaXRodWItd29ya2Zsb3ctZGlzcGF0Y2gtMjA0LXRvLTIwMCJ9.5ClxAWFZHu4zzPwMj8EbXnUPyT2UBYdN&v=up) · [👎 No](https://app.shapi.dev/feedback?t=eyJyIjoiMiIsImEiOiJnaXRodWItd29ya2Zsb3ctZGlzcGF0Y2gtMjA0LXRvLTIwMCJ9.5ClxAWFZHu4zzPwMj8EbXnUPyT2UBYdN&v=down)

---
Opened by [SHAPI](https://shapi.dev). A change is kept only when its contract test failed before it and passes after it. [View this repository in SHAPI](https://app.shapi.dev/a/1/r/2).
