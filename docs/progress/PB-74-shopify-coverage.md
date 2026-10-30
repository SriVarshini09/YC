# PB-74: Every Shopify Admin API breaking change has an advisory (execution plan C-06)

## Why

C-06 asks for the same coverage as C-05, for Shopify: every changelog entry tagged "Breaking API Change" since 2026-01 that touches the Admin GraphQL or REST API should have an advisory. Most of these are GraphQL changes, which PB-73 made matchable by operation and field.

## What changes

- **19 new Shopify advisories**, all `unverified`. They show on the dashboard and never open a PR until verified (C-03).
  - GraphQL changes use the `graphql` trigger on the removed or changed query, mutation or field: `automaticDiscounts`, `marketCurrencySettingsUpdate`, `inventorySetScheduledChanges`, `priceRule`, `metafieldInteger`, `displayFulfillmentStatus`, `totalUnsettledSet`, `customerPaymentMethodRemoteCreate`, `orderUpdate`, `carrierServiceCreate`, `inventoryActivate`, `rateProvider` / `methodConditions`, the segment mutations, the Markets and publishing mutations, and the `PRIVATE` / `PUBLIC_READ` access values.
  - REST changes use their endpoint: order update, carrier service creation, `inventory_levels/connect`, and the `pre_tax_price` line item fields.
  - Effective dates are the API version each change ships in (2026-04, 2026-07, 2026-10, 2027-01), or the publication date for unversioned fixes.
- **`pnpm --filter @shapi/bench bench:shopify-coverage`** reads shopify.dev's changelog feed and checks each breaking Admin API entry since 2026-01. It exits 1 on a gap.
  - An advisory counts when its sources or published notice cite the entry, in either of shopify.dev's URL forms (`/changelog/<slug>` and `/changelog/posts/<slug>`).
- **Four exemptions, each with its reason,** in `datasets/shopify-coverage-exemptions.json`:
  - tax webhook payloads, which Shopify sends to apps rather than calls apps make;
  - metafield filter errors, which depend on a search string and the store's metafield definitions;
  - a removed error code that can no longer occur;
  - the 128 KB JSON metafield limit, which depends on a runtime value.
- **The GraphQL reader also keeps argument keys, enum values written in arguments, and type conditions.** A `graphql` trigger matches them too, for removed input fields (`metafieldInteger`), types and enum values.
- **Calls whose GraphQL document SHAPI can't read** (passed in or built at runtime) are listed once each under "Could not tell", naming the GraphQL advisories they could reach. Before, they got one "possibly affected" finding per advisory, which grew with every advisory added.

## Result

**Zero gaps.** 21 breaking Admin API entries since 2026-01:

- 16 are covered: 15 by the new advisories, and the expiring offline tokens entry by an existing one;
- 4 are exempt, with reasons;
- the 19 advisories include REST twins for the entries that change both APIs.

The public `shapi-advisories` mirror needs the new advisories and the schema with `trigger.graphql` after the next deploy, per the release order.

## Verified

- **Bench tests:**
  - the feed parser;
  - coverage: covered (both URL forms), exempt, gap, and entries outside the cutoff, the Admin APIs or the breaking tag;
  - the new advisories flag code that removes `automaticDiscounts`, reads `priceRule`, or writes `metafieldInteger`, and not a call that queries only `shop`.
- **Core tests:**
  - argument keys, enum values and type conditions as names;
  - matching on them;
  - unreadable documents listed once each under "Could not tell", with no possible findings.
- **Real run:** `bench:shopify-coverage` reports 0 gaps.
- **Full suites from the repository root:** 484 package tests and 168 server tests pass, along with typecheck and lint.
