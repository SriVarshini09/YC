---
description: "How often each API provider's OpenAPI spec changes in a way that breaks clients, measured over the full history of the APIs.guru directory."
---

# Spec churn index

<script setup>
import { data } from "../.vitepress/spec-churn.data";
const pct = (x) => (x * 100).toFixed(1) + "%";
</script>

How often does a new version of a provider's published API description break a client written against the one before? SHAPI replays the whole history of the [APIs.guru openapi-directory]({{ data.directory.repo }}), the largest public collection of OpenAPI specs, and diffs every spec against its previous version.

**Directory commit:** [`{{ data.directory.commit.slice(0, 12) }}`]({{ data.directory.repo }}/commit/{{ data.directory.commit }}) ({{ data.directory.committedAt.slice(0, 10) }}, {{ data.directory.license }}).

**Totals:** {{ data.totals.edits.toLocaleString("en-US") }} spec edits across {{ data.totals.specs.toLocaleString("en-US") }} spec files. {{ data.totals.pairs.toLocaleString("en-US") }} version pairs compared, and {{ data.totals.breakingPairs.toLocaleString("en-US") }} of them breaking.

## What counts as breaking

A new version is **breaking** when it does at least one of these, compared with the version before:

- removes an operation;
- removes a 2xx response;
- removes a parameter, or requires one that was optional or new;
- removes a response property or a schema;
- changes a property's type;
- removes an enum value.

Added enum values and new error statuses don't count here. The diff is the one SHAPI's [spec-history replay](./how-it-works) uses, with Swagger 2.0 specs mapped onto OpenAPI 3 first.

## Ranking

Providers with at least {{ data.minPairs }} version pairs, ranked by the low end of the 95% interval of their breaking rate, so a provider with a few versions doesn't outrank one with hundreds by chance.

<table>
  <thead><tr><th>#</th><th>Provider</th><th>APIs</th><th>Breaking versions</th><th>Rate (95% interval)</th><th>Breaking changes</th><th>Span</th></tr></thead>
  <tbody>
    <tr v-for="(p, i) in data.providers" :key="p.provider">
      <td>{{ i + 1 }}</td>
      <td>{{ p.provider }}</td>
      <td>{{ p.apis }}</td>
      <td>{{ p.breakingPairs }} of {{ p.pairs }}</td>
      <td>{{ pct(p.rate.rate) }} ({{ pct(p.rate.low) }}–{{ pct(p.rate.high) }})</td>
      <td>{{ p.breakingChanges.toLocaleString("en-US") }}</td>
      <td>{{ p.first.slice(0, 4) }}–{{ p.last.slice(0, 4) }}</td>
    </tr>
  </tbody>
</table>

## Limits

- **The directory is a mirror.** A version here is one APIs.guru commit, not necessarily one provider release. Several releases can land in one commit, and a commit can re-render a spec the provider didn't change. Specs whose description only changed form compare as equal.
- **A spec is not the API.** It describes what the provider says the API does. A behaviour change that the spec doesn't mention is invisible here, which is what SHAPI's canaries are for.
- **Not every spec is compared.** Added, renamed and deleted spec files have no previous version to compare against. Specs over {{ (data.maxBytes / 1e6).toFixed(0) }} MB ({{ data.totals.skipped.tooLarge }} versions) and versions that don't parse ({{ data.totals.skipped.unreadable }}) are skipped.

## Reproduce it

```bash
git clone --no-checkout --single-branch https://github.com/APIs-guru/openapi-directory.git packages/bench/.cache/apis-guru
pnpm --filter @shapi/bench bench:spec-churn
```

The script is [`packages/bench/scripts/spec-churn.ts`](https://github.com/SriVarshini09/YC/blob/main/packages/bench/scripts/spec-churn.ts). It writes `packages/bench/results/spec-churn.json`, which this page shows.
