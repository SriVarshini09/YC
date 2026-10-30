# PB-55: The new PR description, and 👍/👎 feedback that is stored (execution plan D-01)

## Why

SHAPI's fix PRs listed sections in the order SHAPI built them. A reviewer had to read to the end to learn the deadline, what changed and whether to trust it. Nothing measured whether the PRs were useful.

## What changes

- **The description (`renderPrBody`).** It now leads with what a reviewer decides on, in order:
  1. a bold lead line with the change and its deadline countdown ("It takes effect on 2027-01-21, in 83 days" or "took effect …, 315 days ago"), with the provider's display name;
  2. one paragraph on the effect in this repository;
  3. a **Call | Before | After | Where** table, with the changed line nearest each call site;
  4. `Size · Tier · Confidence`. Size is lines added and removed over the source changes. Tier is Review until trust levels are earned (U-04). Confidence is high for a recipe that passed every check including your tests, low when the undo or scope check needs a person, and medium otherwise;
  5. **Checked:** the five checks on one line (contract test, your tests, undo check, scope, type check), then what didn't run and why;
  6. **Could change:** one sentence of residual risk, the most important first;
  7. a reminder to check values set outside the repository, for changes that turn on a model, version or header.
- **Collapsible sections:**
  - **What the provider announced:** the notice, or that there was none. Verbatim quotes arrive with C-02.
  - **Affected call sites** and **Change and checks:** the earlier sections, unchanged, including the literal-text safety around Claude's explanations and the repository's code.
  - **Evidence.**
  - **Not changed (N):** the advisory's exposed and possible call sites, each with SHAPI's reason.
- **👍/👎 links.** `feedbackLinks()` signs the repository and advisory with `SHAPI_SHAPE_SECRET` (HMAC, checked in constant time). The link opens a page on the web app with one button, and only the button's POST is stored, so link previews and prefetchers don't vote.
- **Storage.** Migration `0016_pr_feedback` adds a `pr_feedback` table (account, repository, advisory, vote, time) with the same row-level security as `fix_prs`. Who clicked isn't known or kept.
- **Fix job.** It passes the countdown date, the advisory's "Not changed" call sites from the scan's match, and the feedback links.
- **Docs.**
  - The GitHub App guide gains "What a fix PR shows".
  - The quickstart documents A-03's "Could not tell" section of the CLI report.

## Verified

- **Golden file:** `packages/github-app/test/golden/pr-body.md` holds a full recipe fix's description (recorded stub, undo 1/1, scope, your tests, one call site not changed, feedback links). The test fails on any change to it, and checks the parts appear in the order D-01 lists.
- **Clicks are stored:** opening a signed link shows the page and stores nothing. Posting its button stores one row under the repository's account, with the advisory and the vote.
- **Bad links:** a forged, tampered or unsigned link, an unknown vote, or a server without the secret answers 400.
- **Existing tests:** every earlier PR-body test still passes, including the literal-text checks, the type-check table, and the stub, undo, scope and your-tests lines. So does the end-to-end push → scan → fix → PR run.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
