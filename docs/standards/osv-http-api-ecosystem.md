# Draft: an OSV ecosystem for HTTP APIs

*Execution plan S-07. A draft for the founder to file as an issue on [ossf/osv-schema](https://github.com/ossf/osv-schema). Nothing here has been sent.*

## Summary

OSV describes vulnerabilities in packages: a package in an ecosystem, and the version ranges that are affected. Breaking and security-relevant changes in third-party HTTP APIs have no package. The code that breaks pins nothing: it calls an endpoint, and the provider changes what that endpoint accepts or returns. So today these changes can't be expressed in OSV, and the tools that already read OSV (osv-scanner, Dependabot, Renovate, deps.dev) can't warn about them.

We propose an `HTTP API` ecosystem (name open to discussion), where:

- **The package is an API**, named by its provider's host and, where needed, a product, for example `api.github.com` or `api.stripe.com`.
- **The version is the API version the provider defines:**
  - a date (Stripe's `2026-09-30`, GitHub's `2022-11-28`, Shopify's `2025-07`);
  - a path segment (Meta's `v21.0`);
  - or a header or query value (QuickBooks' `minorversion=65`).

  Ranges use the `ECOSYSTEM` type, ordered as the provider orders its versions; dates sort as dates.
- **`affected[].ecosystem_specific`** names what a scanner needs to match code to the change: the HTTP method and path template, and the trigger. A trigger is a response field read, a status code compared, a header or query value sent, or a body value sent (a retired model name).

## Why now: data

[SHAPI](https://shapi.dev) already publishes this data in OSV shape, under its own `x_SHAPI-` prefix, at `https://shapi.dev/osv/<id>.json`, with an index at `https://shapi.dev/osv/index.json`:

- **87 advisories across 16 providers** (GitHub, Stripe, Shopify, OpenAI, Anthropic, Twilio, Meta, HubSpot, QuickBooks, Xero and others). Each record validates against the OSV schema.
- **Churn is common.** Replaying the full history of the APIs.guru OpenAPI directory, 7,714 of 102,455 consecutive spec versions (7.5%) removed or changed something a client could depend on ([spec churn index](https://shapi.dev/guide/spec-churn)). Some providers break clients in a third or more of their published versions.
- **Usage is concentrated, so matching is useful.** In 893 public repositories, the same few endpoints and fields carry most of the usage: 23 of 60 Stripe-using repositories create checkout sessions, and 27 of 89 OpenAI-using repositories read `choices[].message.content` ([provider console](https://shapi.dev/console)).

## What changes in OSV

1. **A new entry in the ecosystems list,** with a definition page: the package naming rule (host, optionally `host/product`) and the version ordering rule (provider-defined; dates sort as dates).
2. **Nothing in the schema itself.** `package.name`, `ranges` of type `ECOSYSTEM`, and `ecosystem_specific` already carry everything. We'd publish the `ecosystem_specific` shape we use as a recommendation, not a requirement.
3. **A database prefix for a curated feed** (SHAPI's or another's), so records can move from `x_SHAPI-` to a listed prefix.

## Example

```json
{
  "schema_version": "1.7.0",
  "id": "SHAPI-github-workflow-dispatch-204-to-200",
  "modified": "2026-02-19T00:00:00Z",
  "summary": "workflow_dispatch returns 200 with a body instead of 204",
  "affected": [{
    "package": { "ecosystem": "HTTP API", "name": "api.github.com" },
    "ranges": [{ "type": "ECOSYSTEM", "events": [{ "introduced": "0" }] }],
    "ecosystem_specific": {
      "endpoint": { "method": "POST", "path": "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" },
      "trigger": { "statusCodes": [204], "newStatusCodes": [200] },
      "change_class": "status-code"
    }
  }]
}
```

## Open questions for the OSV maintainers

- **The name:** `HTTP API`, `Web API`, or one ecosystem per provider (`GitHub API`)? Per provider would be simpler for version ordering, but it grows the list.
- **Changes with no version boundary:** many changes hit every version at once, from an effective date (a model retired, a status code changed silently). Is `introduced: "0"` with an effective date in `database_specific` acceptable, or should a time-based event be considered?
- **Matching:** should scanners match from `ecosystem_specific`, or should OSV stay out of call-site matching and leave it to tools?
