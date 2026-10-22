# Drift observatory v0: do public APIs behave the way their specs say?

Run on 2026-10-22 with `research/scripts/observatory.mjs`. Raw results: `research/data/observatory.csv`, summary `research/data/observatory-summary.json`.

## Method

- **Specs.** The APIs.guru directory (2,529 APIs), officially published specs first, alphabetical. 1,920 specs were downloaded to find the sample.
- **Endpoints.** Per API, up to two GET operations that the spec says need no authentication, no path parameters and no required parameters, and that document a JSON success body.
- **Sample.** One API per provider domain (GitHub alone publishes dozens of spec variants), stopping once 50 providers answered.
- **Excluded.** Specs whose server is a placeholder host (`*.local`, `localhost`, private addresses, which come from self-hosted products) are skipped.
- **Probe.** One unauthenticated request per endpoint, with a `User-Agent` naming SHAPI.
- **Comparison.** Each response was checked against the spec:
  - the status code is documented
  - the content type matches
  - field types and nulls match
  - required fields are present
  - enum values are documented
  - no undocumented fields appear

## Results

**Providers.** 67 providers were tried:

- **12 (18%)** publish a spec whose host no longer exists in DNS. Examples: `hsbc.com` ATM locator, `gsa.gov`, `deutschebahn.com` Betriebsstellen, `archive.org` search, `aviationdata.systems`, `enode.io`.
- **5** had other connection failures (timeouts, expired certificates).
- **50** answered.

Of the 50 that answered:

- **35 (70%)** contradicted their own spec in a way client code can trip over, on at least one probed endpoint.
- **39 (78%)** did so when undocumented extra fields are also counted.

**Endpoints.** 82 endpoints answered:

| Outcome | Endpoints | Share |
|---|---|---|
| Asks for credentials the spec says it doesn't need (401/403) | 27 | 33% |
| Returns 404 for an endpoint the spec still lists | 11 | 13% |
| Other status the spec doesn't document (400, 500) | 7 | 9% |
| Content type isn't the documented JSON | 2 | 2% |
| JSON body contradicts the schema (types, nulls, required fields) | 9 | 11% |
| Only undocumented extra fields | 6 | 7% |
| **Matches the spec** | **20** | **24%** |

**Success bodies.** Of the 35 successful JSON responses compared field by field, 9 (26%) contradict the schema and 10 (29%) carry fields the spec doesn't mention. Examples:

- `cpy.re` PeerTube `/api/v1/accounts` returns an object where the spec says array.
- `handwrytten.com` `/countries/list` returns an object where the spec says array.
- `afterbanks.com` `/forms` returns `business` as a string where the spec says boolean.
- `ebi.ac.uk` ChEMBL returns `null` for fields the spec types as number or string.
- `epa.gov` CASE omits `Results`, which the spec marks required.

**Gone endpoints.** 11 endpoints the specs still list answer 404: `dev.to` `/api/articles` and `/api/articles/latest`, `clarify.io` `/v1/search` and `/v1/bundles`, `infermedica.com` `/concepts` and `/conditions`, and others.

## What it means for SHAPI

A spec is the provider's claim, and in this sample it is wrong about the live API far more often than it is right: only 24% of answering endpoints matched. Tools that diff OpenAPI specs to detect breaking changes inherit that error, while SHAPI watches responses. This is the same gap that let GitHub's `workflow_dispatch` answer 200 while its OpenAPI schema still said 204.

## Limits

- **Small, skewed sample.** The 50 providers are ones whose specs list an unauthenticated, parameter-free GET. That skews toward small and public-data APIs (government, science, hobby APIs) more than toward the large commercial APIs SHAPI targets first. Read the numbers as "spec drift is common", not as an industry rate.
- **Directory staleness.** APIs.guru caches specs. Some disagreements may come from the cached copy lagging the provider's current spec rather than from the provider; a provider-by-provider check would separate the two.
- **Auth not declared.** The 401/403 count partly reflects sloppy spec authoring (auth applied globally but not declared). That is still a contract the spec gets wrong, but a weaker kind than a changed response shape.
- **Single snapshot.** Each endpoint was called once. This run measures spec-vs-reality disagreement, not change over time; repeated runs are what the canary fleet does.
