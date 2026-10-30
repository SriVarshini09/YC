---
description: "What public open-source code depends on in this provider's API: endpoints called and fields read, counted in repositories, never fewer than five."
---

<script setup>
import { useData } from "vitepress";
const { params } = useData();
const list = (counts) => counts.map((c) => `${c.name} (${c.repos})`).join(", ");
</script>

# {{ $params.provider }}: provider console

**{{ $params.report.repos }} public repositories** out of {{ $params.corpusRepos }} scanned call the {{ $params.provider }} API. Each count below is a number of repositories; anything fewer than {{ $params.k }} repositories do is not shown, so no repository can be picked out. {{ $params.report.endpointsBelowK }} more endpoints are called by fewer than {{ $params.k }}.

<p v-if="!$params.report.endpoints.length">No endpoint is called by {{ $params.k }} or more of these repositories yet.</p>

<div v-for="e in $params.report.endpoints" :key="e.operation">
  <h2><code>{{ e.operation }}</code></h2>
  <p><strong>{{ e.repos }} repositories</strong> call it.</p>
  <ul>
    <li v-if="e.fields.length">Response fields read: {{ list(e.fields) }}</li>
    <li v-if="e.statusCodes.length">Status codes compared: {{ list(e.statusCodes) }}</li>
    <li v-if="e.headers.length">Request headers set: {{ list(e.headers) }}</li>
    <li v-if="e.query.length">Query parameters sent: {{ list(e.query) }}</li>
    <li v-if="!e.fields.length && !e.statusCodes.length && !e.headers.length && !e.query.length">Nothing more is used by {{ $params.k }} or more of them.</li>
  </ul>
</div>

[All providers](./) · Corpus: {{ $params.datasets.join("; ") }}
