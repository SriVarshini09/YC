# PB-19 billing fixes: uninstall cancels, one subscription per account, events in any order

These come from the full code review on 2026-10-29 (review 2: H1, H2, M1, L12, L14; review 1: M2, the same bug as H2).

## Why

- **Uninstalling left the customer paying.** `installation.deleted` deleted the account, and the billing row went with it, but nothing cancelled the subscription in Stripe. Every later event for it (the renewal, the cancellation) then tried to write a billing row for the deleted account, failed on the foreign key, and answered 500 until Stripe gave up.
- **A second Checkout could start a second subscription.** The billing page hides Upgrade while the account pays, but the server didn't check. A stale tab or a double click created a second subscription billed alongside the first, and SHAPI tracked only one of them.
- **Stripe events were applied in arrival order.** Stripe doesn't deliver in order, so a late `customer.subscription.updated` (active) could arrive after `.deleted` and make a cancelled account paid again. An event for an old subscription also replaced the live one.
- **One Stripe error stopped the daily billing sync** for every account after it, and every retry stopped at the same account. Expired subscriptions (`incomplete_expired`), which Stripe won't update, were in the loop.
- **The Stripe event id was committed before the event was applied.** A crash in between left the id stored, and Stripe's redelivery was answered "duplicate" and lost.

## What changes

- **Uninstall cancels first** (`cancelOnUninstall` in `billing/stripe.ts`, called from `installation.deleted` in `github/events.ts`). If the billing row holds a subscription that Stripe still bills, the worker cancels it at once, in the uninstall's transaction, with an idempotency key. Paid periods aren't refunded. The outcome, logged as "webhook processed", names the cancelled subscription. If Stripe fails, nothing is deleted and the delivery is retried. A subscription Stripe has already ended, or doesn't know, is not cancelled again.
- **Events for an account that is gone are ignored** with a 200 ("ignored: unknown account"), instead of a 500.
- **Checkout refuses when there's a subscription.** `startCheckout` sends the user back to the billing page when the account's subscription hasn't ended, or when there's nothing to buy (it used to bill one repository even then). The billing page has the buttons that change a live plan.
- **Subscription events use Stripe's current state.** Each `customer.subscription.*` event reads the subscription from Stripe, as `checkout.session.completed` already did. An account has one subscription: an event for a different one never replaces a subscription that is still live. This also keeps a second live subscription from taking over the tracked one ("ignored: account N has another live subscription" in the log).
- **The event id commits with its change**, in one transaction. A failure or crash leaves neither, so the redelivery applies it.
- **The daily sync (`syncAllQuantities`)** logs a Stripe error for one account and goes on with the rest. It skips subscriptions that have ended, and so do `setQuantity` and `syncQuantity`.
- **Docs:** the security page, privacy policy and terms said uninstalling doesn't cancel a subscription. They now say it cancels it at once.

No migration is needed.

## Verified

- New tests in `apps/server/test/billing.test.ts` failed before the fix and pass now: a second Checkout and a Checkout with nothing to buy; a late event after a cancellation; events for an old or extra subscription; uninstall cancelling, then later events answering 200; Stripe refusing the cancellation; already-ended and unknown subscriptions; the sync going past a failing account.
- A Stripe error while reading a subscription leaves no `stripe_events` row, and the redelivery is applied.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
