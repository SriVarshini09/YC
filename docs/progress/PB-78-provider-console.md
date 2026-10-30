# PB-78: Provider console v0 (execution plan PC-01)

## Why

When a provider changes an endpoint, the question is how much code that breaks. SHAPI's api.lock records, for every call a repository makes to a third-party API, the endpoint and what the code depends on: response fields read, status codes compared, and headers and query parameters sent. Counted across many repositories, that answers "how many consumers read this field?" No changelog or spec can answer that.

## What changes

- **`providerConsole(locks, k)`** aggregates api.locks per provider, as counts of repositories.
  - For each endpoint: how many repositories call it, and how many of them read each field, compare each status code, and send each header and query parameter.
  - **k = 5:** any count below 5 is left out, and so is any provider used by fewer than 5 repositories. The report names no repository, file or value: only endpoints and the names of what code reads and sends.
  - A call whose endpoint SHAPI couldn't tell is not listed: a bare URL constant with no method, or a URL built from a variable (`/{}`). Placeholder names (`{owner}`, `{o}`) are normalized, so one endpoint counts once.
- **The corpus is public open-source code only. No customer repository is included.**
  - The 71 benchmark repositories (APIBreak-Replay v0, at their latest fix commit).
  - **`bench:console-corpus`:** for each provider with an npm SDK in `providers.json`, up to 25 public, non-fork repositories whose package.json declares that SDK. They are found with GitHub code search, skip anything over 40 MB, and are frozen at their default branch's commit in `datasets/console-corpus.json`: 825 repositories, built 2026-10-30.
- **`bench:console`** scans each repository once (8 downloads at a time; the corpus archives aren't kept) and writes `results/provider-console.json`.
- **New docs pages:**
  - [shapi.dev/console](https://shapi.dev/console): an index with the privacy rule and the corpus;
  - **a static page per provider** (`/console/stripe` and so on), built with VitePress dynamic routes.

## Result

- **893 of 895 repositories scanned.** One archive was over 225 MB; one commit was gone from GitHub and Software Heritage.
- **34 providers** have at least 5 repositories, and 1 has fewer. **49 endpoints** pass the threshold.
- **Examples:**
  - **Stripe:** 23 of 60 repositories create checkout sessions; 17 of those read `url`, and 14 pin `stripe-version`.
  - **OpenAI:** 42 of 89 call chat completions; 27 read `choices[].message.content`.
  - **Slack:** 35 of 71 post messages; 13 read `ok` and `ts`.
  - **GitHub:** 19 of 150 call `GET /user`, 11 read `login`, 5 compare against 401.
- Many providers show few or no endpoints. Their calls go through SDK methods SHAPI doesn't map to an endpoint yet, or spread over many endpoints with fewer than 5 repositories each.

## Decision for the founder

The plan's wording is "N **installed** repos". Counting customers' repositories would need your call, plus the privacy policy and code-handling policy from SC-01. The same `providerConsole` function and k threshold would apply.

## Verified

- **Unit tests:**
  - counts are repositories, not call sites;
  - endpoints, fields and providers below k are left out but counted;
  - URLs from variables and URLs with no method are left out;
  - the report contains no file path, repository name, header value, or field fewer than k repositories read.
- **The docs build** renders the index and a page per provider from the results file.
