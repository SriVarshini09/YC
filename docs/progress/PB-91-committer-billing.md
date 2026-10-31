# PB-91: Billing per active committer (execution plan I-03)

## Why

The plan calls for billing per active committer (the people who committed to a private repository in the last 90 days), with public repositories free. Billing per private repository charged a small team with many repositories more than a large team with one. The founder asked for placeholder numbers for now.

## What changes

- **Active committers are counted** (`apps/server/src/billing/committers.ts`).
  - When a private repository is scanned with billing on, SHAPI reads its default branch's commits of the last 90 days: up to 10 pages of 100, through the scan's read-only token.
  - It keeps each author as a hash: of the GitHub login, or of the commit's author email when the commit isn't linked to an account, salted with the account id. Identities themselves are never stored.
  - Bots are left out.
  - The count is refreshed before the plan check, so it is current. If GitHub refuses, the last count stands.
- **Migration 0017** adds `repositories.committers` (the hashes) and `committers_at`.
- **The plan** (`plan.ts`) counts the account's active committers: unique people across its enabled private repositories.
  - `FREE_COMMITTERS = 3` (a placeholder) are free. Each further one is a paid seat; the price lives in Stripe.
  - Public repositories are always covered. Private ones are covered while the committers fit the free ones plus the paid seats; beyond that, none is covered until the plan grows. The reason names the count: "6 people committed to private repositories in the last 90 days; the free plan covers 3".
- **Stripe:** Checkout, "add seats" and the daily sync use the committer count as the quantity. The quantity still goes down automatically and up only on a click.
- **The billing page** shows the active committers and the paid seats, with the same buttons, now for seats.

## Not done, and why

- **No Stripe test price was created, and test-mode checkout was not clicked through.** The local safety checks don't let me read the Stripe key. To finish:
  1. In the Stripe dashboard (test mode), create a product "SHAPI seat" with a monthly per-unit price.
  2. Set `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` on a test deployment.
  3. Use Upgrade on the billing page with the test card 4242 4242 4242 4242.
- **The Terms and Privacy pages still describe per-repository plans.** Before billing is turned on:
  - Terms, "Plans", needs the per-committer model;
  - Privacy needs to say SHAPI stores hashed committer identities of private repositories for billing.

  These are the founder's to approve, so they are unchanged.
- **Production has no Stripe billing configured,** so nothing changes for live users until it is.

## Verified

- **Plan rules:**
  - committers are counted across enabled private repositories only (public and archived left out);
  - beyond the free three, private repositories are not covered, with the reason;
  - paid seats cover them; canceled doesn't; `past_due` still does;
  - unenforced covers everything.
- **Hashing:** by login, or else email, case-insensitive; bots left out; per-account salt; no identity in the stored hashes.
- **The web app:** "Upgrade to cover 2 more committers", "5 active committers across 3 private repositories", and Checkout for exactly 2 seats. A repository added after sign-in is counted. "Add 1 seat to the plan" appears when a new committer exceeds the paid seats.
- **The sync** lowers the seats when committers leave, never below one unit.
- **The scan job** recounts `acme/crm`'s committers from GitHub (two people, one bot left out) before deciding, stores only the hashes, and reports "6 people committed …".
