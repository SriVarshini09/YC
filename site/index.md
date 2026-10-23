---
layout: home
title: SHAPI
titleTemplate: Fix the code that breaks when a third-party API changes

hero:
  name: SHAPI
  text: Your code, when the API changes
  tagline: Stripe renames a value, Meta retires a version, GitHub answers 200 instead of 204. SHAPI finds the lines in your code that break, and opens a pull request that fixes them, with a test that proves it.
  actions:
    - theme: brand
      text: Install the GitHub App
      link: https://github.com/apps/shapi-by-srivarshini/installations/new
    - theme: alt
      text: Try the CLI
      link: /guide/quickstart
    - theme: alt
      text: How it works
      link: /guide/how-it-works

features:
  - title: Maps what your code depends on
    details: Every third-party API call in your TypeScript, JavaScript and Python, the endpoint it hits, and what the code relies on in the response, such as a status code, a field or an enum value.
  - title: Knows what changed, before it breaks
    details: An open database of researched API changes and deadlines, each checked against the provider's own pages. It tells apart code that's affected from code that only calls the same endpoint.
  - title: Fixes it, test-first
    details: For each affected call site, SHAPI writes a contract test that fails against the change, applies a deterministic fix, and opens the PR only when the test passes.
---

<script setup>
import { data } from "./.vitepress/advisories.data";
const upcoming = data.upcoming.slice(0, 8);
const days = (d) => Math.ceil((Date.parse(d) - Date.parse(data.builtOn)) / 86400000);
</script>

<div class="landing">

## Third-party APIs change under you

Your tests mock the API the way it worked when you wrote them, so they keep passing while the real one changes. The change might be a status code, a renamed field, a new enum value, a retired version, or an endpoint that's switched off on a date you missed in a changelog. You find out in production.

SHAPI watches for those changes and checks them against **your** code: the exact lines, and why each one breaks.

<div class="stats">
  <div><strong>{{ data.total }}</strong><span>researched API changes</span></div>
  <div><strong>{{ data.upcoming.length }}</strong><span>deadlines still ahead</span></div>
  <div><strong>{{ data.providers.length }}</strong><span>providers</span></div>
  <div><strong>{{ data.withFix }}</strong><span>with an automatic fix</span></div>
</div>

<p class="providers">{{ data.providers.join(" · ") }}</p>

## Upcoming API deadlines

<div class="table-wrap">
<table class="deadlines">
  <thead><tr><th>Date</th><th class="prov-col">Provider</th><th>Change</th><th></th></tr></thead>
  <tbody>
    <tr v-for="a in upcoming" :key="a.id">
      <td class="when">{{ a.effectiveDate }}<br><span>in {{ days(a.effectiveDate) }} days</span></td>
      <td class="prov-col">{{ a.provider }}</td>
      <td><span class="prov">{{ a.provider }} · </span><a :href="a.url">{{ a.title }}</a></td>
      <td><span :class="['sev', a.severity]">{{ a.severity }}</span></td>
    </tr>
  </tbody>
</table>
</div>

<p class="more">All {{ data.total }} are on the <a href="./advisories">advisories page</a>, as open data you can use and contribute to.</p>

## How it works

<div class="steps">
  <div><b>1. Map</b><p>SHAPI reads your code (it never runs it to scan) and writes an <code>api.lock</code>: every API call site and what it depends on.</p></div>
  <div><b>2. Match</b><p>It checks the lock against the advisories and marks each call site that depends on what changed as affected.</p></div>
  <div><b>3. Fix</b><p>A contract test that fails on the change, then a recipe that makes it pass, verified in an isolated sandbox.</p></div>
  <div><b>4. Watch</b><p>Every push is scanned. When a new advisory lands, code SHAPI already mapped is checked again: you get a PR, and a Slack alert if you connect Slack.</p></div>
</div>

## See it on your code

```sh
npx shapi-cli scan .
```

```text
Affected call sites (3)
  CRITICAL  src/deploy.ts:13  POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
            workflow_dispatch returns 200 with a body instead of 204
            why: compares the response status to 204
  HIGH      src/accounting.ts:7  GET /v3/company/{realmId}/query
            Minor versions below 75 are silently answered as minor version 75
            why: sends minorversion=65 (below 75)
  HIGH      src/crm.ts:6  GET /crm-pipelines/v1/pipelines/deals
            Pipelines API v1 retired on 2026-12-04
            why: calls GET /crm-pipelines/v1/pipelines/deals
```

That's SHAPI's demo project. `npx shapi-cli fix . --write` fixes all three, and each fix comes with a test that failed before it and passes after it.

## What a fix PR looks like

- **One PR per change**, covering every affected call site in the repository.
- **The change itself:** for example `minorversion=65` → `75`, or `res.status !== 204` → `![200, 204].includes(res.status)`.
- **A contract test per call site**, with its run before and after the change.
- **The evidence:** the advisory, the provider's notice, the severity, and the sources.
- **Noise controls:** at most 2 new PRs an hour, a PR you closed stays closed, and the `shapi:stop` label freezes a PR.

## Pricing

<div class="pricing">
  <div><b>Free</b><p>Public repositories and one private repository. Scans, checks, fix PRs and Slack alerts included.</p></div>
  <div><b>More private repositories</b><p>A monthly price per repository, announced before it starts. SHAPI asks before anything is charged. Free during early access.</p></div>
</div>

## Your code stays yours

- **Read-only tokens:** each scan uses a token that can only read that one repository, and expires within an hour.
- **Source isn't kept:** only the `api.lock` and the findings are stored.
- **Fixes run in a fresh microVM** with the network off before any of your code runs.
- **Claude is off by default.**

Read [security and code handling](/security), the [privacy policy](/legal/privacy) and the [subprocessors](/legal/subprocessors).

<div class="cta">
  <a class="brand" href="https://github.com/apps/shapi-by-srivarshini/installations/new">Install the GitHub App</a>
  <a class="alt" href="./guide/quickstart">Try the CLI first</a>
</div>

</div>
