# PB-86: Per-endpoint churn baseline (execution plan CN-04)

## Why

Many endpoints have optional fields that come and go between responses: a `discount` only some orders carry, `topics` on some repositories, a `next_page` on all but the last page. Each appearance or disappearance changed the stored shape. So the canary kept reporting candidate changes. Worse, with CN-03's confirmation rule, a real change on such an endpoint could never confirm, because the shape never repeated exactly.

## What changes

- **`churningFields(history)`** (`@shapi/shapes`) learns an endpoint's natural churn from its last 24 observations: the fields whose presence flipped at least twice in successful JSON responses. A field removed for good flips once and stays gone, so it is still a change.
- **The canary compares stable shapes:** each shape with its endpoint's churning fields left out (`stableShape`, `stableHash`). That applies to "changed", to CN-03's "confirmed", and to the diff a draft is made from.
- **Each probe result lists its endpoint's baseline** under `churning`, so every endpoint's churn is documented in the canary report.

## Verified

- **Unit tests:**
  - a field that came and went is learned, one removed for good is not;
  - only successful JSON responses count;
  - stable hashes ignore churning fields but still see a type change.
- **Canary test, an optional field:** GitHub's repo endpoint gains and loses `topics` across cycles. After two flips it is churn (`churning: ["topics", "topics[]"]`), and the next three cycles report no change and draft nothing.
- **Canary test, a real removal on the same endpoint:** `private` disappears for good. It is a candidate, then confirmed, with the diff `field-removed private` (no `topics`) and a draft.
