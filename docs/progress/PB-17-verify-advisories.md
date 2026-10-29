# PB-17: five unverified advisories checked against primary sources

## Why

Five bundled advisories were marked `unverified` because their dates or details rested on secondary reports. Each was re-checked on 2026-10-29 against the provider's own pages. Pages that a plain fetch couldn't read were read in a browser, or through the Wayback Machine where the original is gone.

## What changes

- **hubspot-marketing-emails-v1-sunset → verified.**
  - The 2025-11-01 sunset comes from HubSpot's changelog post (now a 404, read through its Wayback copy).
  - The post says requests to v1 after that date return an error, and that other legacy email APIs are not affected.
  - The CData source is replaced with the v3 guide.
- **quickbooks-refresh-token-five-year-hard-expiry → verified, two fixes.**
  - The scope names are `com.intuit.quickbooks.accounting` and `com.intuit.quickbooks.payments`.
  - The migration note now names the header `x-include-refresh-token-hard-expires-in: true`, which Intuit's cURL examples send. Intuit's parameter table lists `x_refresh_token_hard_expires_in` instead, so the note mentions both.
- **reddit-logged-out-json-403 → still unverified, corrected.**
  - Reddit did announce the change, in r/modnews on 2026-05-28: unauthenticated `.json` endpoints are being shut down, logged-in and authenticated access isn't affected, and developers are pointed to Devvit.
  - The 403 status and the 2026-05-30 date are still only in third-party reports.
- **twilio-notify-end-of-life → verified.**
  - Twilio's Help Center gives 2027-01-31 for existing customers, replacing the 2025-12-31 date in the January 2024 changelog.
  - The Courier source is replaced with the Help Center article and the 2022 EOL notice.
- **xero-allocations-contact-mismatch-rejected → verified.**
  - The 2026-10-08 changelog entry matches. The wording now says Xero is beginning to enforce the rule, as the notice says, and notes the validation error is HTTP 400.

Triggers and endpoints are unchanged, so matching is the same. The same edits go to `shapi-advisories`.

## Verified

- Typecheck and lint are clean, and `pnpm test` passes: 41 files, 289 tests.
