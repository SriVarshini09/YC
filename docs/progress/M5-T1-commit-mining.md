# M5-T1 commit mining

What exists: `research/scripts/commit-mining.mjs` searches GitHub commits month by month for five provider changes (GitHub `workflow_dispatch`, QuickBooks minor versions, Reddit `.json`, Meta Graph version sunset, Xero scopes), records search coverage, matches fixes with per-incident rules, and counts raw API-churn volume for 15 providers. `research/scripts/commit-mining-verified.mjs` turns the hand classification (`research/data/commit-mining-verified.json`) into per-repo rows and lag statistics. The write-up is `research/04-commit-mining.md`.
Findings: GitHub's silent 204→200 change has 58 verified repos. 9 fixed code that rejected the 200 (three on day 0, the rest a median 203 days later, up to 300), 21 later broke on the switch back to an empty 204, and 28 adopted the new run IDs (PyGithub in August 2026). For QuickBooks' silent minor-version change, 12 verified repos moved to 75 at a median 343 days after the change, and one team pinned the ignored version 65 in July 2026. Reddit, Meta and Xero show the same long tail by sampled precision (Reddit roughly 460–630 repos).
How to run: `node research/scripts/commit-mining.mjs --out research/data --raw <raw.json>` (about 12 minutes; uses your `gh` login), then `node research/scripts/commit-mining-verified.mjs <raw.json>`.
Not done: private repositories (out of reach); a second reviewer for the hand classification.
Decisions: a first run's numbers were discarded. The rules matched pull-request numbers like "#204", and newest-first result caps biased the lags, so the search now runs month by month and every headline number comes from hand-verified commits. The raw candidates (about 10,000 commits) aren't committed because of their size.

```
node research/scripts/commit-mining.mjs --out research/data --raw raw.json
node research/scripts/commit-mining-verified.mjs raw.json
```
