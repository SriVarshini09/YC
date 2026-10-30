# PB-76: Fix tiers earned on the benchmark (execution plan U-04)

## Why

A fix that SHAPI verified with a contract test can still be wrong in ways the test doesn't see. How much to trust a fix should depend on how that kind of fix has done before, measured rather than assumed. That rules out a guess per recipe.

## What changes

- **Every fix falls in a cell:** the recipe that made it (or `llm` when Claude wrote any part), the provider, and the change class. Each cell has a tier:
  - **REVIEW:** the fix PR opens as a draft. Every cell starts here.
  - **AUTO:** the fix PR opens ready for review. A cell earns AUTO only on the benchmark: 5 instances fixed with no edit outside the predicted lines, and no instance in the run that the fix failed. Instances whose code couldn't be fetched don't count either way.
  - **ALERT:** no fix PR. The change goes on the Dashboard issue as a manual fix.
- **Only data raises a tier; anything else can only lower it.**
  - Auth and scope changes stay at REVIEW at most.
  - When an account closed three or more fix PRs in a cell without merging, more than it merged, that cell drops one tier for the account. These are the same outcomes U-05's auto-pause counts.
  - The founder can demote a cell in `packages/bench/datasets/tier-demotions.json`, with a reason. Its schema has no AUTO, so a demotion can't promote.
- **The registry, `packages/core/tiers.json`,** lists every verified advisory's cell, the benchmark instances tried in it (passes and failures), any demotion, and the tier earned. A bench test rebuilds it from the latest run under `packages/bench/results/` and fails when the file is out of date (`UPDATE_TIERS=1` rewrites it).
- **The benchmark now records what a fix used:** `fixMethod` (recipe or Claude) and `fixOutOfScope` per instance, so each fix counts toward the right cell.
- **The fix job applies the tier:**
  - An ALERT cell skips the repair. If Claude fixes what the recipe couldn't and Claude's cell is ALERT, no PR opens.
  - A REVIEW cell opens a draft PR.
  - The PR body's `Tier:` line shows the earned tier.
- **New docs page, [Fix tiers](https://shapi.dev/guide/fix-tiers),** shows every cell with its tier, its reasons, and the instances behind it. It is linked from "How fixes are verified".

## Result

**33 cells, all REVIEW.** The P-02 fix runs fixed none of their 4 instances, so no cell has earned AUTO yet:

- 2 failures in `apply-fix/quickbooks/version-sunset`;
- 2 failures in `status-code-accept-set/github/status-code`.

As a result, **every fix PR now opens as a draft.** Before, only fixes that edited outside their predicted lines did.

## Verified

- **Core tests:**
  - REVIEW to AUTO at 5 passes;
  - one failure or scope violation blocks AUTO, while setup errors don't;
  - auth is capped at REVIEW;
  - merge outcomes lower a tier one step;
  - a demotion lowers but never raises, and its schema refuses AUTO;
  - cells for Claude versus recipe fixes;
  - an account's outcomes applied to the registry.
- **Bench tests:**
  - the registry is in sync;
  - every AUTO cell lists at least 5 passes;
  - instances count toward the method that fixed them;
  - demotions apply, and a demotion naming no advisory's cell is refused.
- **Server tests:**
  - the demo fix PR opens as a draft with `Tier: Review`;
  - after three closed PRs in the GitHub status-code cell elsewhere in the account, the job reports `alert`, opens no PR and lists a manual fix.
- **PR body tests:** `Tier: Auto` for an AUTO fix.
