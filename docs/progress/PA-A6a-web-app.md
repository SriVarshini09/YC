# PA-A6a web app

What exists: a web app in the existing web process, server-rendered with no client JavaScript.
- **Sign in with GitHub** through the GitHub App's OAuth client. SHAPI reads who you are and which installations you can access, then drops the user token; it keeps none. The session cookie is signed, HttpOnly and SameSite=Lax, and the database stores only its SHA-256, for 8 hours.
- **Pages:**
  - your accounts
  - each account's repositories: last scan, affected call sites, open SHAPI PRs, paused state
  - each repository: findings with links to the exact lines, fix PR history, recent scans, a link to the dashboard issue.
- **Settings:** PRs per hour and open per repository, failing the check when affected, and opting in to LLM fixes (with what it sends spelled out). A repository can also be paused from the web, separately from the dashboard checkbox; either one pauses.
- **Safety:**
  - every query runs in `withTenant` for an account the user can access on GitHub
  - forms need the session's CSRF token
  - every value is HTML-escaped
  - strict CSP with no scripts, and no framing.
- Migration `0005` adds `sessions`. New config: `SHAPI_GITHUB_CLIENT_ID`, `SHAPI_GITHUB_CLIENT_SECRET`, `SHAPI_PUBLIC_URL`, `SHAPI_SESSION_SECRET` (required in production) and `SHAPI_GITHUB_APP_SLUG`.

Verified: 212 tests pass, 9 of them new. They cover the sign-in flow, the forged-state and failed-exchange paths, no stored user token, hashed sessions, sign-out and tampered cookies, other accounts unreachable by account or repository id, CSRF, settings validation, escaping, and the two pause switches.
Live check, 2026-10-22: signed in with GitHub on the local server through the `shapi-dev-sv` OAuth client. The accounts page listed SriVarshini09, and the account page showed `shapi-demo` with its last scan `09df375` and 2 affected call sites, plus the settings form. The stored session was a 64-character hash with an 8-hour lifetime, limited to installation 174261320, with no GitHub user token anywhere. Locally the server runs on port 8787, because another local service holds 8080; the app's redirect URI is `http://localhost:8787/auth/github/callback`.
Not done: Stripe billing (A6b, after the pricing decision).

```
pnpm test
pnpm build && pnpm --filter @shapi/server dev     # PORT=8787 SHAPI_PUBLIC_URL=http://localhost:8787 if 8080 is taken
```
