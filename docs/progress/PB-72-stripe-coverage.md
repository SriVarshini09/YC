# PB-72: Every Stripe breaking change on a mapped method has an advisory (execution plan C-05)

## Why

The spec replay (P-08) measured what a spec diff finds. C-05 asks the coverage question for SHAPI's own database: every breaking change Stripe announced in Dahlia and Endive that touches a Stripe method SHAPI maps should have an advisory, so a customer calling that method is told.

## What changes

- **`pnpm --filter @shapi/bench bench:stripe-coverage`** (`src/coverage.ts`, `scripts/stripe-coverage.ts`):
  - reads the GA "Breaking" entries of each release's first version from docs.stripe.com;
  - maps each entry's REST resources to the Stripe SDK methods in `providers.json`;
  - reports each touching entry as covered (an advisory cites it), exempt, or a gap, and exits 1 on any gap;
  - writes `results/stripe-coverage.json`.
- **Exemptions:**
  - entries about preview APIs only, where every link is to the `.preview` API version, are exempt automatically. It's the same test the spec replay uses, since the GA API doesn't change;
  - `datasets/stripe-coverage-exemptions.json` holds any other exemption, with its reason. It's empty today.
- **Four new advisories,** all `unverified`, so they're on the dashboard and never open a PR until verified (C-03):
  - `stripe-endive-checkout-session-payment-method-types-removed`: `payment_method_types` on Checkout Session creation returns 400;
  - `stripe-endive-payment-intent-payment-method-types-removed`: the same on Payment Intent create, update and confirm;
  - `stripe-endive-setup-intent-payment-method-types-removed`: the same on Setup Intents;
  - `stripe-endive-billing-cycle-anchor-object`: `billing_cycle_anchor` takes an object instead of `now` / `unchanged`.

## Result

**Zero gaps.** Seven breaking entries in Dahlia and Endive touch a mapped Stripe method:

- four are covered: the existing Checkout `ui_mode` advisory, and the new ones;
- three are preview-only:
  - Stripe balance `source_type`;
  - PayPay `capture_method`;
  - Trial Offers.

The public `shapi-advisories` mirror needs the four new files after the next deploy, per the release order.

## Verified

- **Unit tests** (`packages/bench/test/coverage.test.ts`):
  - resource-to-method mapping, including object-level rows;
  - covered, preview-exempt, hand-exempt, gap, unmapped and non-breaking entries;
  - the new advisories are unverified.
- **Real run:** `bench:stripe-coverage` reports 0 gaps.
- **Checks:** typecheck, lint, and the bench, core and CLI tests pass with the new advisories.
