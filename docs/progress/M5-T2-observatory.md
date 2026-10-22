# M5-T2 drift observatory v0

What exists: `research/scripts/observatory.mjs`, raw results in `research/data/observatory.csv` and `observatory-summary.json`, and the write-up `research/05-observatory.md`. The script takes officially published OpenAPI specs from the APIs.guru directory (1,920 checked), keeps GET endpoints the spec says need no auth or parameters, probes one API per provider domain until 50 answer, and compares each response with its spec: status, content type, types and nulls, required fields, enums, and undocumented fields.
Findings (2026-10-22): of 67 providers tried, 12 (18%) publish a spec for a host that no longer resolves in DNS. Of the 50 that answered, 35 (70%) contradict their own spec on at least one endpoint. Only 20 of 82 answering endpoints (24%) fully match. The rest: 33% demand undeclared auth, 13% answer 404 for listed endpoints, 9% return other undocumented statuses, and 26% of successful JSON bodies contradict the schema.
How to run: `node research/scripts/observatory.mjs --out research/data` (about 3 minutes; one request per endpoint).
Not done: repeated runs over time (the canary's job); provider-by-provider separation of directory staleness from provider drift.
Decisions: one API per provider domain, so GitHub's many spec variants don't dominate; placeholder hosts (`*.local`, self-hosted products) are skipped; dead hosts and 404s are reported as their own categories. The sample skews toward small and public-data APIs, so the write-up presents the numbers as "spec drift is common", not as an industry rate.

```
node research/scripts/observatory.mjs --out research/data
```
