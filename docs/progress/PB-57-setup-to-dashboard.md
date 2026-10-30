# PB-57: The Setup URL lands on the account's dashboard (execution plan U-01)

## Why

With the Setup URL set on the live App, saving the App's settings on GitHub landed on SHAPI's account picker, not a dashboard. A person who can open more than one account had to click again, and U-01's test is one click.

## What changes

- **`/setup` reads the `installation_id` GitHub adds**, and redirects to that account's dashboard (`/a/<account>`) when the session can open it.
- **Signed out, or a session from before the install:** the installation goes into a short-lived signed cookie (10 minutes, `/auth` only), and sign-in starts. After sign-in, the callback sends the person to that account's dashboard and clears the cookie. Sign-in picks up new installations, so a fresh install works too.
- **Fallbacks:** without an installation, or for an account the person can't open, it's the usual page (the dashboard for one account, or the picker). An installation that isn't a number is ignored.

## Verified

- **Tests** (`apps/server/test/web.test.ts`), for a user who can open two accounts:
  - `/setup?installation_id=…` goes to each one's dashboard;
  - signed out, it goes through sign-in and the callback lands on the dashboard, clearing the cookie;
  - an unsigned or tampered cookie, or an installation the user can't open, falls back to `/`;
  - a malformed installation sets no cookie.
- **Full suite:** typecheck, lint and tests pass.
