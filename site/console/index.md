---
description: "Provider console v0: what public open-source code depends on in each provider's API, from SHAPI's api.lock scans, counted in repositories with a five-repository minimum."
---

# Provider console

<script setup>
import { data } from "../.vitepress/provider-console.data";
</script>

When a provider changes an endpoint, it wants to know how much code that breaks. SHAPI's [api.lock](/guide/how-it-works) records, for every call a repository makes to a third-party API, the endpoint and what the code depends on: the response fields it reads, the status codes it compares, and the headers and parameters it sends. Counted across many repositories, that answers "how many consumers read this field?".

This v0 counts **public open-source repositories only**: {{ data.corpus.scanned }} scanned ({{ data.corpus.datasets.join("; ") }}). Customers' repositories are not included.

**Privacy rule:** every number is a count of repositories, and anything fewer than {{ data.k }} repositories do is left out, as is any provider used by fewer than {{ data.k }} ({{ data.providersBelowK }} providers). No repository, file or value is named.

<table>
  <thead><tr><th>Provider</th><th>Repositories</th><th>Endpoints listed</th></tr></thead>
  <tbody>
    <tr v-for="p in data.providers" :key="p.provider">
      <td><a :href="`./${p.provider}`">{{ p.provider }}</a></td>
      <td>{{ p.repos }}</td>
      <td>{{ p.endpoints.length }}</td>
    </tr>
  </tbody>
</table>

Rebuild it with `pnpm --filter @shapi/bench bench:console` ([script](https://github.com/SriVarshini09/YC/blob/main/packages/bench/scripts/provider-console.ts)); the corpus is frozen in `packages/bench/datasets/console-corpus.json`.
