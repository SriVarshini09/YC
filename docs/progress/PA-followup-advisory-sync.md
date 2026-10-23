# Follow-up: advisory sync and A6a leftovers

What changed:
- **Advisory sync:** `upsertAdvisories` no longer stamps `modified` on every sync. Before, each worker start, which happens on every deploy, made `advisory-fanout` treat every advisory as new, re-match every repository and queue fix jobs (sandbox runs where a recipe applies). A row now updates only when its data, reviewed flag or source differs. A test re-syncs an unchanged advisory (nothing written, `modified` unchanged) and then an edited one (written, `modified` later).
- **Billing redirect:** the page CSP's `form-action 'self'` also covers where a submitted form redirects, so the browser silently blocked Upgrade and Manage billing from reaching Stripe. Stripe's checkout and portal hosts are now allowed, with a test. The dev server also loads `.shapi/stripe.env`. Found in the live billing check, which then passed (see PA-A6b).
- **A6a leftovers:** the commit pushed to the A6a branch after PR #33 was merged, never on main until now. It adds the live sign-in record to `PA-A6a-web-app.md`, and makes the dev server listen on `localhost` (IPv4 and IPv6).

Verified: the full test suite passes. In the live run after this fix, a server restart synced 0 advisories and re-matched 0 repositories.

```
pnpm test
```
