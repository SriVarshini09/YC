---
description: "The open database of third-party API behavior changes SHAPI matches your code against: the format, every advisory, and how to contribute."
---

# Advisories

An advisory describes one third-party API behavior change: which endpoint, what changed, when it took (or takes) effect, **exactly what code it breaks**, how to migrate, and the evidence. SHAPI's advisories are open data in a public repository:

**[github.com/SriVarshini09/shapi-advisories](https://github.com/SriVarshini09/shapi-advisories)**, licensed under CC BY 4.0.

The CLI ships a copy; the GitHub App syncs the repository every hour.

## Format

One JSON file per advisory, validated against a [JSON Schema](https://github.com/SriVarshini09/shapi-advisories/blob/main/schema/advisory.schema.json) on every pull request.

```json
{
  "id": "github-workflow-dispatch-204-to-200",
  "provider": "github",
  "title": "workflow_dispatch returns 200 with a body instead of 204",
  "endpoint": { "method": "POST", "path": "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" },
  "changeClass": "status-code",
  "trigger": { "statusCodes": [204], "newStatusCodes": [200] },
  "effectiveDate": "2025-12-19",
  "severity": "critical",
  "recipeId": "status-code-accept-set",
  "status": "verified",
  "sources": ["https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids"]
}
```

The real files have more fields: a summary, when the change was first observed, the provider's notice if there was one, and a migration note. Key fields:

- **`changeClass`**: `status-code`, `field-rename`, `enum-added`, `required-field`, `version-sunset`, `scope-change` or `auth`.
- **`trigger`**: what a call site must depend on to be **affected**. Calls that don't depend on it are only **exposed**.
- **`status`**: `verified` means checked against a primary source or two independent ones; `unverified` means secondary reports only.
- **`recipeId`**: the deterministic fix SHAPI applies, when there is one.

## All advisories

<script setup>
import { data } from "./.vitepress/advisories.data";
</script>

{{ data.total }} advisories: {{ data.verified }} verified, and {{ data.withFix }} with a fix SHAPI can apply automatically.

<table>
  <thead><tr><th>Effective</th><th>Provider</th><th>Change</th><th>Severity</th><th>Status</th></tr></thead>
  <tbody>
    <tr v-for="a in data.all" :key="a.id">
      <td style="white-space: nowrap">{{ a.effectiveDate }}</td>
      <td>{{ a.provider }}</td>
      <td><a :href="a.url">{{ a.title }}</a><span v-if="a.fix"> · automatic fix</span></td>
      <td>{{ a.severity }}</td>
      <td>{{ a.status }}</td>
    </tr>
  </tbody>
</table>

## Contribute

Found an API change that broke your code? Open a pull request in the advisory repository. Its [contribution guide](https://github.com/SriVarshini09/shapi-advisories/blob/main/CONTRIBUTING.md) explains the evidence an advisory needs. Corrections to existing advisories are as welcome as new ones.
