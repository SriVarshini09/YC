---
description: "How far SHAPI trusts its fixes for each recipe, provider and kind of change, and the benchmark runs that earned it."
---

# Fix tiers

<script setup>
import { data } from "../.vitepress/tiers.data";
</script>

Every fix falls in a **cell**: the recipe that made it (or Claude), the provider, and the kind of change. Each cell has a tier that decides what SHAPI does with a verified fix:

- **REVIEW**: the fix PR opens as a **draft**, for a person to check. Every cell starts here.
- **AUTO**: the fix PR opens ready for review. A cell earns it only on the benchmark: {{ data.autoAfter }} instances fixed with no edit outside the predicted lines, and no instance in the run that the fix failed.
- **ALERT**: no fix PR. The change is listed on the Dashboard issue as a manual fix.

The tiers come from data, never from hand:

- **Authentication and scope changes stay at REVIEW**, whatever the benchmark says.
- **Merge outcomes lower a tier.** When three or more of your fix PRs in a cell were closed without merging, more than were merged, that cell drops one tier for your account: AUTO to REVIEW, REVIEW to ALERT.
- **SHAPI can demote a cell**, with a reason shown below. A demotion can only lower a tier.

Every fix PR shows its tier next to its size and confidence.

## The registry

From the benchmark run on {{ data.benchmark.dataset }}, SHAPI {{ data.benchmark.shapiVersion }}, {{ data.benchmark.runAt.slice(0, 10) }}: {{ data.counts.AUTO }} cells at AUTO, {{ data.counts.REVIEW }} at REVIEW, {{ data.counts.ALERT }} at ALERT.

<table>
  <thead><tr><th>Recipe</th><th>Provider</th><th>Change</th><th>Tier</th><th>Benchmark</th><th>Why</th></tr></thead>
  <tbody>
    <tr v-for="c in data.cells" :key="`${c.recipe}/${c.provider}/${c.changeClass}`">
      <td><code>{{ c.recipe }}</code></td>
      <td>{{ c.provider }}</td>
      <td>{{ c.changeClass }}</td>
      <td>{{ c.tier }}</td>
      <td>
        {{ c.passes.length }} fixed, {{ c.failures.length }} not
        <details v-if="c.passes.length || c.failures.length">
          <summary>Instances</summary>
          <div v-for="id in c.passes" :key="id">✅ <code>{{ id }}</code></div>
          <div v-for="id in c.failures" :key="id">❌ <code>{{ id }}</code></div>
        </details>
      </td>
      <td>{{ c.reasons.join("; ") }}</td>
    </tr>
  </tbody>
</table>

The benchmark and its instances are in [`packages/bench`](https://github.com/SriVarshini09/YC/tree/main/packages/bench); the registry is `packages/core/tiers.json`, rebuilt from the latest run.
