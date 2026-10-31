# APIBreak-Replay: methodology

APIBreak-Replay measures whether SHAPI catches real third-party API breakages. Every instance is a public GitHub repository whose maintainers fixed the breakage by hand. SHAPI scans the commit before the fix, where it should flag the code, and the fix commit, where the flag should be gone. Nothing in the repositories is run: the scan is static.

Other tools are scored the same way on the [leaderboard](LEADERBOARD.md); [SUBMISSIONS.md](SUBMISSIONS.md) says how to add one.

## Data

- **Source:** SHAPI's commit mining of public GitHub commits that adapt to a provider change, hand-classified on 2026-10-22. That covers 71 repositories: 58 for GitHub's `workflow_dispatch` 204→200 change and 13 for QuickBooks Online ignoring `minorversion` below 75.
- **Dataset:** `datasets/apibreak-v0.json`, built by `scripts/build.ts` from the verified CSV. Each instance records the repository, the fix commit and its first parent (the base), the date, the lag in days after the provider's change, the SHAPI advisory it tests, the repository's license and its primary language.
- **Which instances are scored.** An instance is scored only when both of these hold, and every unscored instance keeps its reason in the dataset:
  1. Its hand label is a breakage fix with a SHAPI advisory. The GitHub labels `empty-204` (the February 2026 partial revert, which has no SHAPI advisory yet) and `run-details` (adopting a new feature) are not scored.
  2. The fix removes a line that shows the old behavior (`TRIGGER_EVIDENCE` in `src/instances.ts`): a check for `204`, or a `minorversion` below 75. A fix that only *adds* a minor version proves nothing about the code before it.
- **Unavailable commits** (a deleted repository, a force-pushed branch) are kept and reported as unavailable.
- **Mirror.** Every instance is mirrored in [Software Heritage](https://archive.softwareheritage.org), the public archive of source code (execution plan P-07):
    - [`datasets/apibreak-v0.mirrors.json`](datasets/apibreak-v0.mirrors.json) holds each instance's mirror URL (`swh:1:rev:<fix commit>`) and whether it is archived;
    - `bench:archive -- --save` asks Software Heritage to archive the repositories it does not hold yet, and `bench:archive` records the result;
    - when GitHub answers 404 for a commit, `bench:run` fetches it from Software Heritage's vault instead, so a deleted repository still scores.
    - The mirror file is kept apart from the dataset, so the dataset's hash and the CI baseline do not change when it is updated.

## Metrics

Each metric is a share of the scored instances, with its count `k`, the number of instances `n`, and a 95% Wilson score interval (`src/metrics.ts`). No number is published without `n`.

| Metric | Definition |
| --- | --- |
| Flag recall | SHAPI reports `affected` for the instance's advisory at the base commit. |
| Flag recall with possible | The same, also counting `possible`. |
| Flag recall in scanned files | Flag recall where the evidence line is in a file type SHAPI scans (TypeScript, JavaScript, Python). |
| Fixed-state precision | SHAPI no longer reports `affected` at the fix commit. A flag that survives the human fix counts as a false positive, even when it is right (see adjudications). |
| Fix rate | Of the instances flagged `affected` at the base commit whose fix was tried (`bench:run -- --fix`), the share SHAPI fixed completely: every affected call site changed, with a contract test that failed before and passes after, in the sandbox with the network off. Sandbox and install failures are left out and counted in `fixErrors`. `null` when fixes did not run. |

## Running it

```sh
pnpm --filter @shapi/bench build
pnpm --filter @shapi/bench bench:build -- --csv <commit-mining-verified.csv>   # only to rebuild the dataset
pnpm --filter @shapi/bench bench:run
pnpm --filter @shapi/bench bench:run -- --fix                              # also fix each affected instance in the sandbox
```

- **Output:** results go to `results/<shapi version>/<dataset hash>.json`, with the git commit they were produced at.
- **Fixes (`--fix`):** each instance flagged `affected` at its base commit goes into a sandbox, exactly as the GitHub App's fix job runs it (`scripts/fix.ts`):
  - dependencies install with only the npm registry reachable, then the network is cut;
  - SHAPI repairs every affected call site test-first with its recipes, then Claude;
  - it uses E2B when `E2B_API_KEY` is set, and Claude when `ANTHROPIC_API_KEY` is set, at most `--llm-calls` calls for the run (40 by default). `ANTHROPIC_BASE_URL` and `SHAPI_REPAIR_MODEL` route Claude through a gateway.
- **Token:** set `GITHUB_TOKEN`, or sign in with `gh`. Archives are downloaded through GitHub's API, which limits unauthenticated use.
- **Okapi head-to-head:** `pnpm --filter @shapi/bench bench:okapi` scans the base commit of every public Okapi PR and rewrites the table in [OKAPI.md](OKAPI.md) (execution plan P-04).

## Regression gate

The benchmark is also the matcher's regression suite (execution plan P-05). The `bench` job in CI runs `bench:run -- --cache .cache --check` on every pull request and push to main. It compares each in-scope instance with [baseline.json](baseline.json), one by one, and fails when:

- **a catch is lost:** an instance `affected` at its base commit in the baseline is not `affected` now;
- **a new false positive appears:** an instance not `affected` at its fix commit in the baseline is `affected` now;
- **an instance cannot be scanned** for a reason other than its repository or commit being gone. Run it again.

Comparing one by one means a lost catch cannot hide behind a new one, which a rate alone would allow.

Other cases:

- **Gone:** a repository or commit that returns 404 is reported, not failed. P-07 archives the repositories.
- **Improvements:** they pass, and the report asks for `--update-baseline`. Commit the new `baseline.json` with the change that earned it.
- **A changed dataset:** this fails until the baseline is rebuilt for it.

Archives are cached in `packages/bench/.cache`, because a commit's archive never changes. Removing #93's matcher fix makes the gate fail: it loses `vincentng295/gemini_fbchat` and recall drops from 5 / 14 to 4 / 14.

## Baseline (git main at 61f95b3+, dataset `37fa931e8278`, 2026-10-29)

| Metric | k / n | Rate | 95% interval |
| --- | --- | --- | --- |
| Flag recall | 4 / 14 | 29% | 12–55% |
| Flag recall in scanned files | 4 / 10 | 40% | 17–69% |
| Fixed-state precision | 13 / 14 | 93% | 69–99% |

### History

Each SHAPI change measured on dataset `37fa931e8278` (14 scored instances). Precision is fixed-state precision.

| Change | Flag recall | In scanned files | Precision |
| --- | --- | --- | --- |
| Baseline (#91) | 4 / 14 | 4 / 10 | 13 / 14 |
| `{repo}` holding `owner/name` after `/repos/` matches `{owner}/{repo}` | 5 / 14 | 5 / 10 | 13 / 14 |

### Adjudications

- **hfscdogg/outgrow** is still `affected` at its fix commit because the fix left `minorversion=65` in `scripts/smoke_creds.py` line 130. SHAPI's flag is correct. The metric still counts it as a false positive by the definition above.
- **theomleslie-ops/bakery-dashboard-2** is `affected` at its fix commit from shapi-cli 0.3.5 on, which reads requests inside wrappers. The fix moved `pipeline/qb-pl-fetcher.js` to `minorversion: 75`, but `pipeline/qb-client.js` line 86 still sends `minorversion: 70` (checked on GitHub at the fix commit, 2026-10-31). SHAPI's flag is correct. It counts as a false positive by the definition above.
- **tioperfumes07/IH35-TMS** is `affected` at its fix commit from shapi-cli 0.3.5 on, for the same reason. The fix moved most QuickBooks calls to `minorversion=75`, but `apps/backend/src/integrations/qbo/sync-outbound-accounting.ts` keeps `const MINOR_VERSION = 70` and sends it on lines 143 and 166 (checked on GitHub at the fix commit, 2026-10-31). SHAPI's flag is correct. It counts as a false positive by the definition above.

### What the misses show

1. **A path variable holding `owner/name`** (fixed: see History). In `f"{api_base}/..."` with `api_base = .../repos/{repo}`, the variable fills two path segments, but the advisory's pattern has `{owner}/{repo}` (vincentng295/gemini_fbchat).
2. **Code in files SHAPI does not scan:**
    - `curl` calls in GitHub Actions workflow YAML (refracta/df-translations, kikujizo/ai-harness);
    - OCaml (stategraph/stategraph);
    - Rust (opaque-dev/opaque).
3. **Query parameters passed through helpers:**
    - a `params` dict through a wrapper function (Chamfer-Consulting/gpc-purchase-order-hx, Tans2101/Trenston);
    - a relative path on a configured client (mindstone/mcp-servers);
    - an axios-style `params` object (theomleslie-ops/bakery-dashboard-2).
4. **Status checks on other response objects:** `response.status` from aiohttp (dlstupka/hth).

Each gap becomes a fix in SHAPI's extractor or matcher. Its acceptance test is that instance turning `affected`, with no new false positives on the fix commits.

## v1 (execution plan P-14)

`datasets/apibreak-v1.json` has 363 instances, 208 of them scored. It keeps v0, except voilalz/frontier-pulse: GitHub deleted that repository before Software Heritage could archive it (P-07). It adds 293 instances mined on 2026-10-31 by `scripts/mine.ts` (`bench:mine`) from public commit messages, each labeled from its own diff:

| Incident | Added | Scored | Label rule |
| --- | --- | --- | --- |
| Meta Graph v21.0 sunset | 113 | 113 | A scanned source file drops `v21.0` next to Graph/Meta/version wording, for a newer version |
| Meta Graph v20.0 sunset | 60 | 60 | The same for `v20.0` |
| Meta Graph, older than v20.0 | 99 | 0 | No SHAPI advisory covers those versions |
| QuickBooks minorversion | 14 | 14 | Removes a `minorversion` below 75 and adds one at 75 or more |
| GitHub workflow_dispatch | 7 | 7 | Removes a check for `204` |

- **Auto-classified.** Unlike v0, these labels are automatic. They wait for a hand review, and until then v1 results are reported apart from v0's.
- **Left out.** Commits that only mention the dispatch call (143) are not in v1.
- **The Meta incidents test a version sunset.** The code before the fix pins a Graph API version that Meta retires, and the fix moves it to a supported one.
- **Where it runs.** v1 runs on demand in the `bench v1` workflow (`.github/workflows/bench-v1.yml`), which keeps its results as an artifact. CI's regression gate stays on v0.

### v1 results (shapi-cli 0.3.5, dataset `ef24b946b806`, 2026-10-31)

From the `bench v1` workflow run [41185568409](https://github.com/SriVarshini09/YC/actions/runs/41185568409). Per instance: `results/0.3.5/ef24b946b806.json`.

| Incident | Scored | Flag recall | Fixed-state precision |
| --- | --- | --- | --- |
| Meta Graph v20.0 sunset | 60 | 98% (59/60, 95% CI 91–100%) | 92% (55/60, 95% CI 82–96%) |
| Meta Graph v21.0 sunset | 108 | 80% (86/108, 95% CI 71–86%) | 82% (89/108, 95% CI 74–88%) |
| QuickBooks minorversion | 21 | 67% (14/21, 95% CI 45–83%) | 71% (15/21, 95% CI 50–86%) |
| GitHub workflow_dispatch | 14 | 50% (7/14, 95% CI 27–73%) | 100% (14/14, 95% CI 79–100%) |
| **All** | **203** | **82% (166/203, 95% CI 76–86%)** | **85% (173/203, 95% CI 80–89%)** |

- **Errors.** Five instances could not be scanned (unavailable archives) and count against SHAPI.
- **Precision is not adjudicated.** On v0, every fix commit SHAPI still flagged turned out to have left an old value somewhere else. v1's 30 such commits have not been checked yet, so its precision is a lower bound until they are.

## Limits

- **Small, public, hobby-leaning repositories.** Public commit search skews toward small projects, so this is evidence of the pattern, not of market size.
- **Labels.** The hand labels are one reviewer's judgement. The evidence rule makes the scored set mechanical, but the source classification can be re-checked.
- **Two incidents only (v0).** Meta, Xero and Reddit instances come next, after hand verification.

## Fix rate, first run

Run on 2026-10-30 at SHAPI 0.3.1 in E2B, Claude through Vercel AI Gateway (`anthropic/claude-fable-5.1`). **0 of 4 fixed** (95% interval 0–49%), and 1 install failure. Claude was never called: each instance stopped before a fix could be tried.

| Instance | Why it was not fixed |
| --- | --- |
| `vincentng295/gemini_fbchat` | The call site is Python. SHAPI fixes TypeScript and JavaScript only. |
| `hfscdogg/outgrow` | The call site is Python. |
| `pyzz58/gpt-recommendations` | The call site is not inside an exported function, so a contract test cannot call it. |
| `RCOLKITT/AccountingQB-MCP` | The repository has no root `package.json`, so nothing installed vitest and the contract test could not run. |
| `tioperfumes07/IH35-TMS` | `npm ci` failed (install failure, left out of the rate). |

These are the work list for the fix rate: Python fixes, a test harness for code outside exported functions, and installs for repositories without a root `package.json` or with a lockfile `npm ci` rejects.
