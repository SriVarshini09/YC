# PB-61: Spec-history replay for GitHub (execution plan P-09)

## Why

P-08 measured, on Stripe, how many of a provider's breaking changes a published spec shows. P-09 asks the same of GitHub, where SHAPI's first advisory (workflow dispatch `204` → `200`) comes from.

## What changes

- **`pnpm --filter @shapi/bench bench:spec-replay:github`** diffs `github/rest-api-description`'s `2022-11-28` and `2026-03-10` descriptions at the same commit.
  - It scores the changes against the `2026-03-10` section of GitHub's breaking-changes page, which lists each change with its affected endpoints.
  - It records what `GET /versions` answers.
  - It writes `results/spec-replay/github/2026-03-10.json` (score, entries, changes, drafts) and the GitHub table in `packages/bench/SPEC-REPLAY.md`.
- **`src/spec-replay-github.ts`:**
  - `parseGithubBreakingChanges()` reads one version's entries: wrapped titles, affected endpoints, and the field, value and status names a title quotes.
  - `changeMatchesGithubEntry()` and `scoreGithubReplay()` do the scoring.
- **The diff now reads GitHub's spec too:**
  - shared parameters under `components.parameters`;
  - array responses;
  - enums on array items (`languages: ["python", …]`);
  - with `statusAdded`, status codes an operation newly answers. GitHub lists a new error status as breaking; Stripe doesn't, so it's off by default.
- **Drafts** name the provider (`providerName`) instead of always saying Stripe, and fall back to `/**` when the operations share no prefix.
- **Stripe, rerun:** recall is unchanged. The array-enum fix finds 19 more changes (260 instead of 241), and 31 of them match only a non-breaking row (was 20). `SPEC-REPLAY.md` has the new numbers.

## Results

- **20 of 26 breaking changes found (77%); 20 of the 23 a spec can show (87%).** This includes workflow dispatch `204` → `200`, the five `451` trade-controls statuses, and the removed `rate`, `merge_commit_sha`, `has_downloads` and `assignee` fields.
- **3 behavior-only:** content type, media type, a validation rule.
- **3 missed:** `/hub` is in neither spec; `bundle` is in an inline response schema; the submodule `type` change is in meaning, not in the schema.
- **Changes GitHub's page doesn't list:** `master_branch` and `base-gist.user` removed, and `return_run_details` removed from the dispatch request. The issue `pull_request` URLs becoming non-nullable is a false positive of the diff.

## Verified

- **Unit tests:**
  - the page parser on a sample with a wrapped title, quoted names and two versions;
  - the diff on two small GitHub-shaped specs (JSON body, shared parameter, array response, array-item enum, added status only when asked);
  - matching and every score bucket;
  - GitHub drafts validate against `AdvisorySchema`.
- **Real run:** `results/spec-replay/github/2026-03-10.json`.
- **Checks:** typecheck, lint and the bench tests pass. CI runs the full suite.
