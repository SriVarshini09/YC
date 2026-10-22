# Commit mining: how long it takes teams to fix third-party API breakage

Run on 2026-10-22 with `research/scripts/commit-mining.mjs` (search and rule matching) and `research/scripts/commit-mining-verified.mjs` (hand-verified sets). Data in `research/data/commit-mining-*`.

## Method

- **Search.** For five provider changes SHAPI has advisories for, GitHub commit search was queried month by month from 30 days before the change to today. Only public, non-fork repos are kept, and SHAPI's own repos are excluded.
- **Count.** One commit per repo: the first one that adapts to the change.
- **Verify by hand.**
  - GitHub `workflow_dispatch` and QuickBooks: every repo whose commit *subject line* mentions the change was read and classified (94 and 22 repos). The verified lists are `research/data/commit-mining-verified.json` and `.csv`.
  - Reddit, Meta Graph and Xero: rule-matched repos were sampled (25 each, random) and judged, which gives a precision range.
- **Coverage.** Recorded per incident. GitHub and Reddit had more search matches than the search API returns, so their candidate sets are partial and the counts are lower bounds.

## The GitHub `workflow_dispatch` change (silent, 2025-12-19)

GitHub's dispatch endpoint started answering 200 with a body instead of 204, without a changelog. On 2026-02-19 GitHub made the 200 opt-in (`return_run_details`); without it the endpoint answers 204 again. Of the 94 candidate repos, 58 were verified:

| What the commit did | Repos | First | Median days after the change | Latest |
|---|---|---|---|---|
| Fixed code that rejected the new 200 | 9 | same day (3 repos) | 203 | 300 |
| Fixed code that broke on the empty 204 after GitHub switched back | 21 | 40 | 165 | 304 |
| Adopted the run ID now returned by the dispatch | 28 | 74 | 290 | 305 |

- **Most teams found out months later.** Three repos fixed it on day 0, including Stategraph (Terrateam), which reported it. The other six "accept 200" fixes landed **138 to 300 days later**: mend/docker-base-images (May), kikujizo/ai-harness (July), dlstupka/hth (August), opaque-dev/opaque (September), voilalz/frontier-pulse and pyzz58/gpt-recommendations (October 2026). That's code that treated a successful dispatch as a failure for four to ten months.
- **One change broke twice.** 21 teams fixed code that failed on GitHub's switch *back* to an empty 204 ("handle 204 No Content", "JSON parse error"), from January to October 2026. Every behavior change, even a revert, costs someone a fix.
- **Libraries had to follow.** PyGithub added `return_run_details` in August 2026, eight months after the behavior changed, and the same fix landed in five Kubescape-related repos on one day in October.

## QuickBooks minor versions (silent, 2025-08-01)

Since 2025-08-01 QuickBooks Online ignores any `minorversion` below 75 and answers as 75, without an error. Coverage was complete (268 search matches). Of the 22 candidate repos:

- **12 moved their calls to minor version 75**, at a median **343 days** after the change; the latest was 419 days. One moved early (July 2025), and the rest from December 2025 to September 2026.
- **One team pinned the old version in July 2026**: "apply minorversion=65 to all QBO calls" (toyslatam/dl-qb-sync), eleven months after Intuit started ignoring 65.

Silent changes don't get fixed when they happen; they get fixed when someone notices, if anyone does.

## Three more changes, by rule match and sampled precision

| Change | Kind | Repos matched | Precision (sample of 25) | Estimated real | Timing |
|---|---|---|---|---|---|
| Reddit logged-out `.json` returns 403 (2026-05-30) | silent | 1,047 (partial coverage) | 44–60% | ~460–630 | median 59 days after; p90 129 |
| Meta Graph API version sunset (v20, 2026-09-24) | announced deadline | 114 (complete) | 84–88% | ~96–100 | half moved in the 30 days before; the rest a median 11 days after |
| Xero granular scopes for new apps (2026-03-02) | announced rule | 283 (complete) | 60–80% | ~170–225 | median 124 days after; still arriving in October |

- **Reddit.** Fixes switch to OAuth, RSS feeds or third-party archives ("fall back to RSS (Reddit now 403s public .json)"). Another 16% of the sampled repos dropped Reddit as a source entirely.
- **Meta.** An announced deadline concentrates work near the date, and still a large share lands after it. Commits like "Move off the Graph API version that expired eight months ago" show the tail.
- **Xero.** The rule applies to every app created after March 2026, so new integrations keep hitting `invalid_scope` and fixing it months later ("Fix Xero OAuth invalid_scope: accounting.transactions was retired for new apps", October 2026). A deadline isn't a one-time event.

## Volume by provider (upper bound, last 12 months)

Commits whose message contains "`<Provider> API`" together with "deprecated", "breaking change" or "no longer" (`research/data/commit-mining-providers.csv`):

| Provider | Raw matches |
|---|---|
| OpenAI | 26,726 |
| Anthropic | 14,662 |
| GitHub | 11,449 |
| Stripe | 2,620 |
| Slack | 1,039 |
| Google Maps | 836 |
| Shopify | 698 |
| Twilio | 436 |
| Twitter/X | 300 |
| Reddit | 237 |
| Facebook Graph | 150 |
| HubSpot | 123 |
| Salesforce | 104 |
| QuickBooks | 98 |
| Xero | 36 |

These counts are an upper bound on breakage work, not a count of fixes. Many matches deprecate the team's *own* code or mention the provider in passing. They do show where API-churn language concentrates: LLM providers, then GitHub and Stripe.

## What it means for SHAPI

- **The fix lag is months, not days.** For the two silent changes we verified by hand, the median fix came 203 days (GitHub, rejecting 200) and 343 days (QuickBooks) after the provider changed behavior. That's the window SHAPI closes: canaries see the shape change the day it ships, and the matcher knows which call sites depend on it.
- **Breakage repeats.** The same GitHub endpoint broke integrations twice, once on the change and again on the partial revert. Every provider change is two-way.
- **Announced deadlines leave a long tail too** (Meta, Xero), so watching your code against advisories is worth it even when a changelog exists.

## Limits

- **Public repos only.** Commit search sees public repos, which skew toward small teams and side projects. Companies hit by these changes mostly fix them in private repos, which we can't count. Read the repo counts as evidence of the pattern, not as market size.
- **Lag measures when a fix was committed, not when the breakage started.** Some late fixes come from code written after the change (new integrations that hit it at once). For QuickBooks and Xero that is part of the point: the change keeps biting new code.
- **Hand classification is one reviewer's judgment** from subject lines. The verified lists are committed so anyone can check them.
- **Partial coverage** for GitHub and Reddit: those counts are lower bounds. Raw candidate data (about 10,000 commits) isn't committed because of its size; rerun with `--raw` to regenerate it.
