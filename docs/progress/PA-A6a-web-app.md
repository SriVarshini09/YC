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
Not done: Stripe billing (A6b, after the pricing decision), and a live sign-in, which needs the callback URL added to the GitHub App.

```
pnpm test
pnpm build && pnpm --filter @shapi/server dev     # then open http://localhost:8080
```
