# demo-ts

A tiny TypeScript service used by SHAPI's tests and demo. It is never installed or run; SHAPI reads it statically.

- `src/deploy.ts` dispatches a GitHub Actions workflow and requires `res.status === 204` (breaks under the 204 to 200 change).
- `src/billing.ts` creates a Stripe customer with a pinned `apiVersion`.
- `src/accounting.ts` queries QuickBooks Online with `minorversion=65`.
- `src/crm.ts` reads HubSpot deal pipelines through the v1 Pipelines API (sunset 2026-12-04).

`api.lock` is the committed reference output of `shapi scan fixtures/demo-ts --out fixtures/demo-ts/api.lock`.
