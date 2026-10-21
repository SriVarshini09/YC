# M1-T8 demo fixture and tests

What exists: `fixtures/demo-ts/`, a small TypeScript service (never installed): `src/deploy.ts` dispatches a GitHub workflow and throws unless `res.status === 204`; `src/billing.ts` creates a Stripe customer with a pinned `apiVersion`; `src/accounting.ts` queries QuickBooks with `minorversion=65`; `src/crm.ts` reads HubSpot pipelines through the v1 API. `fixtures/demo-ts/api.lock` is the committed reference output. `packages/cli/test/demo.test.ts` asserts the GitHub call site at `src/deploy.ts:13` is affected by the 204 to 200 advisory (critical, under 10 s), QuickBooks and HubSpot are affected, Stripe is found with its version header, the `.ok`-only GitHub call is not flagged, and the lock matches the committed file (`UPDATE_LOCK=1 pnpm test` rewrites it). A root README documents the demo.
How to run: `pnpm install`, then `npx shapi scan fixtures/demo-ts` (about 1 s wall clock; exits 1 because of the critical finding).
Not done: Milestone 2 (canary fleet, shape diff) has not started.
Decisions: added the HubSpot call (beyond the plan's GitHub, Stripe, QuickBooks) so the "deadlines in 90 days" section shows a real dated deadline.

```
pnpm install
npx shapi scan fixtures/demo-ts
```
