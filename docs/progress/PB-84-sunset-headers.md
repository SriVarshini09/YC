# PB-84: Deprecation, Sunset and deprecation-reason headers in witnesses (execution plan CN-05)

## Why

Some providers announce a change in the response itself, before any changelog: RFC 9745 `Deprecation`, RFC 8594 `Sunset`, a `Link` to the deprecation notice, or Shopify's `X-Shopify-API-Deprecated-Reason`. A canary probe that records these sees the deadline as soon as the provider starts sending it.

## What changes

- **Already there, from A-01:** witnesses read `Deprecation` (RFC 9745 `@<seconds>` or an HTTP-date), `Sunset`, and the version-echo headers (GitHub, Stripe, OpenAI, Anthropic, QuickBooks, Shopify).
- **Two new fields on the witness,** both left out when absent, so witnesses without these headers keep their shape ids:
  - **`deprecationReason`:** Shopify's `X-Shopify-API-Deprecated-Reason`, up to 300 characters;
  - **`deprecationLink`:** the first `Link` marked `rel="deprecation"` or `rel="sunset"`.

  The published witness schema (`/schema/witness-v1.json`) is regenerated.
- **Shopify's reason header is a contract value in the stored shape,** so a probe that starts receiving it flags a `version-sunset` signal, like `Deprecation` and `Sunset` do.

## Verified

- **Witness:** the Shopify reason and the deprecation link are read from a mixed `Link` header and the API version is echoed; both fields are absent when the headers are; the witness still validates.
- **Probe:** a canary run in which GitHub's repo endpoint starts sending `Sunset`, `Deprecation: @…` and a `rel="sunset"` link:
  - the witness records the Sunset date (2027-01-31T23:59:59Z), the deprecation date and the link;
  - the probe is flagged changed, with `deprecation` and `sunset` as `version-sunset` changes.
