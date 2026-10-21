# M1-T5 advisory format and seed

What exists: `AdvisorySchema` in `packages/core/src/advisory.ts` (provider, endpoint pattern with `{param}`/`*`/`**` and optional host filter, change class, trigger, first observed, published notice, effective date, severity, migration note, optional recipe id, sources, verified/unverified status), `loadAdvisories(dir)`, and a committed JSON Schema at `packages/core/schema/advisory.schema.json`. `advisories/` holds 7 seeds: GitHub workflow_dispatch 204 to 200 (critical), QuickBooks minorversion below 75 ignored, Xero accounting.transactions scope split (cutoff 2027-09-13), Reddit logged-out .json 403, Meta Graph v20.0 (2026-09-24) and v21.0 (2027-01-21) sunsets, HubSpot Pipelines API v1 sunset (2026-12-04).
How to run: `pnpm test packages/core`.
Not done: the matcher that applies triggers (T1.6). No Stripe or OpenAI advisory: I found no dated deadline for them in the window.
Decisions: the trigger is what separates "affected" from "exposed" (for example GitHub fires only when the code compares against 204; QuickBooks only when `minorversion` is below 75). Every date was checked on the web on 2026-10-21. Reddit is marked `unverified` (no primary Reddit notice found). The HubSpot `/crm-pipelines/v1` path comes from the legacy v1 reference, not the notice itself. GitHub's Feb 2026 changelog made 200 opt-in via `return_run_details`, but gh CLI 2.87+ sends it by default, so the advisory still applies.

```
pnpm test packages/core
```
