# PB-77: Spec churn index from the APIs.guru history (execution plan P-17)

## Why

"APIs break clients all the time" needs a number. The APIs.guru openapi-directory holds more than ten years of published OpenAPI specs for hundreds of providers. Diffing each spec against its previous version shows how often a new version would break a client written against the old one, provider by provider.

## What changes

- **`pnpm --filter @shapi/bench bench:spec-churn`** reads a clone of the directory (no checkout, about 650 MB) and diffs every spec version against the one before it. It uses the spec-replay engine from P-08, keeping only changes that break a client:
  - a removed operation, 2xx response, parameter, property, schema or enum value;
  - a newly required parameter;
  - a changed property type.

  Added enum values and new statuses don't count.
- **Swagger 2.0 specs are mapped onto OpenAPI 3** first (`definitions`, shared `parameters`, and a parameter's type on the parameter itself), so both spec formats compare the same way.
- **The work is split across processes.** Spec files are spread over up to 16 processes, and each file's versions stay in order within one process. YAML is parsed with `js-yaml`, which is fast enough for about 200,000 parses. The first attempt used `yaml` and was far too slow.
- **Ranking:** providers with at least 10 version pairs are ranked by the low end of the 95% Wilson interval of their breaking rate, so a provider with a handful of versions doesn't top the list by chance.
- **New docs page: [shapi.dev/guide/spec-churn](https://shapi.dev/guide/spec-churn).** It shows the ranking, the directory commit, the method, the limits and the command to reproduce it. It is linked from "How SHAPI works".

## Result

**Directory commit `f04b8d0bcd39`** (2026-04-20, CC0):

| | Count |
|---|---|
| Spec edits | 103,799 |
| Spec files | 5,818 |
| Version pairs compared | 102,455 |
| Breaking pairs | 7,714 (7.5%) |
| Providers with ≥ 10 pairs | 401 |
| Skipped: over 3 MB | 601 |
| Skipped: unparseable | 445 |

The run took about a minute on 16 processes.

**Top of the ranking:** rebilly.com (41 of 65 versions breaking), beezup.com, just-eat.co.uk, telnyx.com, redirection.io.

**Providers SHAPI covers:**

| Rank | Provider | Breaking versions | Rate |
|---|---|---|---|
| #6 | Stripe | 23 / 50 | 46% |
| #9 | Adyen | 711 / 2,098 | 34% |
| #13 | GitHub | 13 / 30 | 43% |
| #21 | AWS | 1,721 / 8,965 | 19% |
| #63 | Azure | 1,154 / 12,055 | 9.6% |
| #108 | Twilio | 28 / 387 | 7.2% |
| #124 | Google APIs | 2,811 / 66,470 | 4.2% |

**Limits, also stated on the page:**

- **A version is one APIs.guru commit,** which may bundle several provider releases or re-render a spec that didn't change.
- **Many providers' entries stopped updating years ago.** Stripe's ends in 2021, and OpenAI, Shopify and HubSpot have fewer than 10 pairs. The index measures history as the directory mirrored it, not current churn.
- **A spec describes what the provider says.** Behaviour changes the spec doesn't mention are invisible here.

## Verified

- **Unit tests:**
  - Swagger 2.0 mapping (removed operation, newly required parameter, removed enum value through a shared `$ref` parameter, removed and retyped definition properties);
  - OpenAPI 3 passthrough;
  - added enum values are not breaking;
  - raw git log parsing (only modified spec files, oldest first);
  - provider and API naming;
  - ranking by the interval's low end, with the minimum pair count.
- **The docs build** renders the page from `results/spec-churn.json`.
