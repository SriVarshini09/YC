# APIBreak-Replay: methodology

APIBreak-Replay measures whether SHAPI catches real third-party API breakages. Every instance is a public GitHub repository whose maintainers fixed the breakage by hand. SHAPI scans the commit before the fix, where it should flag the code, and the fix commit, where the flag should be gone. Nothing in the repositories is run: the scan is static.

## Data

- **Source:** SHAPI's commit mining of public GitHub commits that adapt to a provider change, hand-classified on 2026-10-22. That covers 71 repositories: 58 for GitHub's `workflow_dispatch` 204→200 change and 13 for QuickBooks Online ignoring `minorversion` below 75.
- **Dataset:** `datasets/apibreak-v0.json`, built by `scripts/build.ts` from the verified CSV. Each instance records the repository, the fix commit and its first parent (the base), the date, the lag in days after the provider's change, the SHAPI advisory it tests, the repository's license and its primary language.
- **Which instances are scored.** An instance is scored only when both of these hold, and every unscored instance keeps its reason in the dataset:
  1. Its hand label is a breakage fix with a SHAPI advisory. The GitHub labels `empty-204` (the February 2026 partial revert, which has no SHAPI advisory yet) and `run-details` (adopting a new feature) are not scored.
  2. The fix removes a line that shows the old behavior (`TRIGGER_EVIDENCE` in `src/instances.ts`): a check for `204`, or a `minorversion` below 75. A fix that only *adds* a minor version proves nothing about the code before it.
- **Unavailable commits** (a deleted repository, a force-pushed branch) are kept and reported as unavailable.

## Metrics

Each metric is a share of the scored instances, with its count `k`, the number of instances `n`, and a 95% Wilson score interval (`src/metrics.ts`). No number is published without `n`.

| Metric | Definition |
| --- | --- |
| Flag recall | SHAPI reports `affected` for the instance's advisory at the base commit. |
| Flag recall with possible | The same, also counting `possible`. |
| Flag recall in scanned files | Flag recall where the evidence line is in a file type SHAPI scans (TypeScript, JavaScript, Python). |
| Fixed-state precision | SHAPI no longer reports `affected` at the fix commit. A flag that survives the human fix counts as a false positive, even when it is right (see adjudications). |
| Fix rate | Not measured yet: it needs fixes run in the sandbox (`null` in the results). |

## Running it

```sh
pnpm --filter @shapi/bench build
pnpm --filter @shapi/bench bench:build -- --csv <commit-mining-verified.csv>   # only to rebuild the dataset
pnpm --filter @shapi/bench bench:run
```

- **Output:** results go to `results/<shapi version>/<dataset hash>.json`, with the git commit they were produced at.
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

## Limits

- **Small, public, hobby-leaning repositories.** Public commit search skews toward small projects, so this is evidence of the pattern, not of market size.
- **Labels.** The hand labels are one reviewer's judgement. The evidence rule makes the scored set mechanical, but the source classification can be re-checked.
- **Two incidents only (v0).** Meta, Xero and Reddit instances come next, after hand verification.
