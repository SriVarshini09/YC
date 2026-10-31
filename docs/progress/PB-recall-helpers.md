# Recall: requests inside helpers, urllib, and conditional base URLs

## Why

On the APIBreak-Replay leaderboard (P-19), Claude Code flagged 57% of the real breakages and SHAPI 0.3.1 only 36%. Reading the evidence files of the cases SHAPI missed showed one main cause in Python: the request is made inside a small helper whose URL, query or body come from the helper's parameters.

- `_qbo_get(url, headers, params)` around `requests.get` (Chamfer-Consulting).
- `_dispatch(endpoint, …)` around `urllib.request.urlopen` (dlstupka/hth).

SHAPI evaluated a call only where the HTTP library is called, so the URL stayed unknown and nothing was matched. Two smaller gaps came with it:
- Python's `urllib.request` wasn't recognized as a client.
- A base URL chosen by a conditional (sandbox or production host) wasn't evaluated, either in Python (`_api_base()` returning a conditional constant, Tans2101) or in TypeScript (a ternary, theomleslie-ops/bakery-dashboard-2).

## What changes

- **Python helpers** (`packages/extractor/src/python.ts`). When an HTTP call's arguments use a parameter of the function around it, SHAPI reads the call once per caller of that function in the same file, with that caller's arguments: positional, keyword and defaults, and `self.` calls for methods.
  - Callers that reach the same endpoint form one call site carrying every distinct query value, header and body field they send.
  - When no caller makes the call resolvable, the call stays as before.
- **`urllib.request`.** `urlopen(url)` and `urlopen(Request(url, data=…, method=…, headers=…))`, with the Request inline or in a variable. A Request with data and no method is a POST, as urllib sends it. `response.status` is the status checked.
- **Python expressions:**
  - conditional expressions;
  - a same-file helper's return value (`f"{_api_base()}/v3/…"`);
  - a dict in a local variable (`params = {…}`) passed as `params=`/`json=`/`headers=`.
- **TypeScript.** Conditional (ternary) expressions in a URL.
- **CI.** `bench:run --check` can write its results (`--results-out`), and the bench job keeps them as an artifact. A change's new numbers can then be committed without scanning the instances again.

## Verified

- New extractor tests:
  - urllib, with a Request in a variable, inline, and as a plain URL;
  - a helper read through two callers, by positional and keyword arguments and a local dict, plus a method called through `self`;
  - a helper with no resolvable caller staying unresolved;
  - a helper's return value with a conditional constant;
  - a TypeScript ternary base URL matched against the QuickBooks advisory.
- All extractor tests pass (90).
- Each missed case's evidence file, at its base and fix commits, scanned with this build: dlstupka, Chamfer-Consulting, Tans2101 and bakery-dashboard are now affected at base and only exposed at fix. mindstone's client is built in another file, which this doesn't reach.
- **The benchmark (this PR's CI run, 0.3.3):** flag recall is 64% (9/14), up from 36% (5/14) in 0.3.1, and fixed-state precision is unchanged at 93% (13/14). SHAPI now leads Claude Code (57%, 86%) on both. `baseline.json` records the new catches, so CI guards them.
