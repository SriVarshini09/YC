# PA-A6b billing

What exists: Stripe billing for the plan "free for public repositories and one private repository, then a monthly price per private repository". The price itself lives in Stripe: SHAPI only stores its ID (`STRIPE_PRICE_ID`), so no amount is in the code.
- **Plan rules** (`billing/plan.ts`): public repositories are always covered, and the oldest private one is free. Further private ones are covered while the subscription pays for them (`active`, `trialing`, or `past_due` while Stripe retries). Without Stripe configured, everything is covered.
- **Web app:** the account page shows the plan and marks uncovered repositories. It offers exactly one action: **Upgrade** (Stripe Checkout for the extra private repositories), **Add N repositories to the plan** (a prorated update, only on that click), or **Manage billing** (the Stripe portal). Returning from Checkout reads the session from Stripe, so the plan updates before the webhook arrives; a session from another account is refused.
- **`POST /stripe/webhook`:** verifies the signature on the raw body and applies each event once (`stripe_events`). It handles checkout completion and subscription create, update and delete. A failure answers 500 so Stripe redelivers.
- **Jobs:** the scan and fix jobs skip private repositories the plan does not cover. `billing-sync` (after repository changes, and daily) lowers the paid quantity when private repositories go; it never raises it.
- **Database and config:** migration `0006` adds `billing` (tenant-scoped, row-level security) and `stripe_events`. Config: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID`, all three or none; a live key outside production is refused.

Verified: 219 tests pass, 7 of them new, against a fake Stripe. They cover the plan rules, config, Checkout with the exact quantity and customer metadata, CSRF, signed webhooks (bad signature 400, duplicates ignored), paid then cancelled coverage, the portal, the raise-only-on-click and automatic lowering, the return-from-Checkout sync with another account's session refused, and scan enforcement. The embedded test Postgres now retries startup on a new port (a rare parallel-start port clash).
Live check, 2026-10-22, in a Stripe sandbox (test key, $1/month test placeholder price):
1. With two private repositories installed, the account page showed the free plan, tagged `shapi-billing-test` as not covered, and offered "Upgrade to cover 1 more private repository".
2. The first click was silently blocked by the page's own CSP (`form-action 'self'` also governs redirects); fixed in PR #35.
3. Checkout with the test card 4242 returned to SHAPI, and the plan synced from the checkout session (no webhook forwarded locally): `active`, 1 paid repository, renewing 2026-11-23. In Stripe the subscription was active with `livemode=false` and the $1 test invoice paid.
4. Manage billing opened the Stripe portal; cancelling showed "Cancels Nov 23".
Not done: the price itself; forwarding live Stripe webhooks to a deployed server; showing "cancels on" in SHAPI (Stripe's `cancel_at_period_end` is not stored yet).

```
pnpm test
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... STRIPE_PRICE_ID=price_... pnpm --filter @shapi/server dev
```
