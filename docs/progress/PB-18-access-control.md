# PB-18: each person sees only their repositories; settings and billing need an admin

From review 1 of the full code review (2026-10-29), web layer.

## Why

At sign-in SHAPI read `GET /user/installations` and treated every installation it lists as the whole account. GitHub lists an installation to anyone with explicit access to **one** of its repositories. So an outside collaborator on `acme/docs` could:
- read the names, file paths, call sites and fix diffs of every other acme repository, private ones included;
- replace the Slack webhook, turn off "fail the check" or change PR limits;
- pause any repository;
- open Checkout or the Stripe billing portal.

The same review found smaller web-layer bugs, fixed here too (see below).

## What changes

### Who sees and manages what (the founder's policy)

- **Sign-in** also reads `GET /user/installations/{id}/repositories` (paginated, with the user token) for each installation. The session stores, per installation, the GitHub repository ids the user can read, can push to (push, maintain or admin) and administers, and whether the installation is on the user's own personal account. The token is still discarded.
- **Migration `0011_session_repo_access`** adds `sessions.access` (jsonb, not null) and deletes existing sessions, which lack it: everyone signs in again.
- **Every account page shows only the repositories the user can read:** overview, problems, fixes, repositories, API changes and its timeline, the sidebar counts and the health score. `loadAccount` takes `readable` and filters repositories, scans, findings and fix PRs; `loadFinding` takes it too. Another repository's page, finding or pause is a 404, as for another account. Row-level security per account is unchanged; this filter sits on top.
- **Plan coverage** still counts every repository of the account (`planRepos`, ids and plan fields only), so "not covered by plan" stays right for a user who sees only some.
- **Pausing or resuming** needs push access. Without it, the repository page shows no button, and the POST is a 403.
- **Settings, the Slack test, and every billing page and action** need an account admin: for a personal account its owner, and for an organization a user who is admin on every repository SHAPI covers there (organization owners are). Anyone else gets an "Account admins only" 403 page, and the sidebar leaves out Settings and Billing. The overview's checklist offers "Connect Slack" only to admins.
- **Docs:** `site/security.md`, `site/guide/github-app.md` and `site/legal/privacy.md` say who sees and manages what, and what sign-in reads.

### Pause posts the state it wants

The Pause/Resume form posts `paused=1` or `paused=0`, and the server sets that value instead of flipping it (L6). The write is one `settings || jsonb_build_object('pausedFromWeb', …)` on the locked row, so a dashboard edit saved at the same time keeps its keys (the web side of M1). A form without `paused` changes nothing.

### Other review findings

- **L1:** `sameToken` compares byte lengths, so a same-length non-ASCII CSRF token or OAuth state is a 403/400, not a 500.
- **L2:** ids have at most 18 digits, so an id beyond Postgres' bigint is a 404, not a 500.
- **L3:** notice lookups (`?slack=`, `?billing=`) use `Object.hasOwn`, so `constructor` or `__proto__` show no notice.
- **L4:** the docs server splits paths on `\` too, so `%5c` can't reach dot files or walk back on Windows.
- **L5:** the finding page validates the advisory with `AdvisorySchema` and uses only reviewed rows, as the other pages do.
- **L7:** "fix by hand" and "on the way" follow what the fix job does: a recipe this build has, or Claude when the account opted in and the server has a key. The finding page mentions the Claude setting only when the server offers it. The "on the way" texts mention plan coverage, and the API changes table labels a change "automatic" only when its recipe exists.
- **L8:** `/logout` clears the cookie only for a valid session and CSRF token, so a cross-site POST cannot sign anyone out.
- **L9:** GitHub file links encode each path segment.
- **Minor:** "Sign-in cancelled" when the user declines on GitHub. A change due today says "today", not "in 0 days". The score and empty-repositories texts say scans start on install. A Slack field of only spaces counts as empty. A `back` path must be printable ASCII.

## Verified

- New tests in `apps/server/test/web.test.ts`, using `fakeUserGitHub` (new in `test-utils/fake-github.ts`):
  - a collaborator on one repository sees only it on every page, with its counts, and gets 404 for the other repository's page, finding and pause;
  - a read-only user can't pause, and a user with push can;
  - a user who is admin on only some repositories gets 403 on settings, the Slack test and billing, and nothing changes;
  - an organization admin and a personal-account owner can open and save settings, while a collaborator on someone else's personal repository can't;
  - pausing twice keeps the repository paused, and a concurrent dashboard edit survives a pause;
  - one test for each of L1, L2, L3, L5, L7, L8, L9 and the minor fixes.
- `docs.test.ts`: `/%5c.hidden` and `/guide%5c..%5cindex.html` return 404.
- Against the old source, every new test fails except "an organization admin can change settings", which the old code allowed too. With the fixes, they all pass.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
