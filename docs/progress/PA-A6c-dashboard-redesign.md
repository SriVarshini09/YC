# PA-A6c web app dashboard redesign

What exists: the web app is a dashboard with a fixed dark-navy sidebar and a light main area of white cards on a pale blue-gray background (blue accent, Inter, rounded cards, soft shadows, hover states), with a dark theme. Still server-rendered with **no client JavaScript**: charts are inline SVG, tooltips are `<title>` elements and CSS, and the theme is a cookie the shell reads.

**Pages** (all under `/a/<account>`; the sidebar shows live counts):
- **Overview**: API health ring (share of third-party call sites that still work, less a little per affected call site by severity and per failed scan; "Healthy" only with nothing affected), four stat cards (affected call sites, fixes merged, deadlines in 90 days, providers watched), the deadline timeline (next 180 days, red to 30 days, amber to 90, green after; changes already in effect stacked at day 0), a provider grid with monogram marks and green/amber/red status, and a recent activity feed (scans, PRs opened/merged/closed, new affected call sites).
- **Repositories**: every repository with providers, affected/exposed counts, fix PRs and last scan.
- **Repository**: a health strip, then every call site grouped by provider from the latest `api.lock` (plus any finding the lock does not list); affected rows highlighted, each linking to its finding and fix PR. Fix PRs and recent scans below. Pause/resume as before.
- **Finding** (`/f/<id>`, new): what changed (summary, endpoint, dates, provider notice, sources, migration note), where in the code and why it is affected, **expected vs actual** (derived from the advisory's trigger/fix and the call site's surface: status codes, renamed fields, enum values, pinned versions), and **the fix**: the four verification steps, the contract test **failing before and passing after** (vitest output in a disclosure), and the unified diff per file.
- **Findings**, **Fix PRs**, **Deadlines**, **Advisories** (54 reviewed changes, providers in the code first, filter by provider), **Settings** (moved off the account page), **Billing** (plan cards; Stripe return URLs now land here). PB-7's "cancels on" date shows on the plan card and the renewal card.
- Sign-in and the account picker are a centered card; one account goes straight to its overview (`/?all` lists them).

**Launch-oriented (2026-10-25):**
- **Public landing page** at `/` for signed-out visitors, replacing the sign-in card: hero with an example catch, live numbers (APIs watched from the provider registry, reviewed advisories from the database), how it works in three steps, every supported API, the real GitHub 204-to-200 break with its fix, security promises, Free and Team pricing as the docs landing page states it (free during early access; the per-repository price is announced before anyone is charged), and sign-in and install calls to action. Every claim maps to something the product does today.
- **Value-first overview**: a hero that says how many breaking API changes SHAPI found (counted once per repository and change, across current findings and fix PRs), how many fixes merged, PRs to review and changes still needing attention, with the health ring beside it. Then the latest catch (why it broke, the test failing before and passing after, the changed lines, the four proof steps, and Review PR / See the full fix), and a "Needs your attention" list: PRs to review, changes with no automatic fix, fixes closed unmerged, failed scans, changes due within 30 days, and fixes still on the way.
- **First run**: no repositories shows a welcome with the install button; repositories with no finished scan show scan progress per repository and the page refreshes itself every 10 seconds (a meta refresh, no script). A "Get started" checklist (install, first scan, Slack alerts, first merged fix) shows until all four are done.
- The overview and its widgets moved to `overview.ts`, the landing page is `landing.ts`; link helpers and the page head live in `views.ts`.
- The preview seeds two more accounts: `newco` (first scan running) and `fresh-start` (nothing installed).

**Data for the finding page**: migration `0008_fix_pr_repair` adds `fix_prs.repair` (jsonb). The fix job stores a `FixRepair` with the PR: method, recipe, sandbox, each call site's test file with its before/after run (verdict, vitest count, output tail), and a unified diff per file cut at 400 lines. Written when the PR is created or updated; an unchanged PR keeps what it had. PRs recorded before 0008 show "details on the PR".

**Security**: unchanged rules, checked by tests. CSP stays `default-src 'none'` with no scripts; `font-src 'self'` is added because Inter is served from this origin (`@fontsource-variable/inter`, latin subset). The CSP forbids inline `style=` attributes, so none are used (a test asserts this on every page). Forms keep the CSRF token (theme switch included); every value is escaped; tenant isolation covers the new finding route (another account's finding id is a 404). The stylesheet URL carries a content hash so a deploy never serves an hour-old cached sheet.

**Preview**: `pnpm build && pnpm --filter @shapi/server preview` starts a throwaway Postgres with a seeded demo account (five repositories, locks, findings, fix PRs with verification) on http://localhost:8788/preview/login (`?theme=dark`), with no GitHub or Stripe. Used for the screenshots.

Every page fits a 375-pixel phone screen without sideways scrolling (checked in a real browser; headless Chrome cannot render narrower than about 500 pixels, so its phone screenshots look cropped).

Verified: typecheck, lint, and the suite pass (web tests cover every page, the theme cookie, no inline styles, the finding page's comparison and PR link, and cross-tenant 404; fix delivery tests cover storing and keeping the repair summary; a unit test covers the summary and diff cut).

Not done: real provider logos (the marks are colored monograms, drawn here, so nothing is loaded from elsewhere and no trademarked artwork ships); charts beyond the ring and the timeline.

**Merged with main (2026-10-25):** PB-7 (one PR per advisory: the fix job now stores the summary of the whole multi-site repair), PB-8 and the new logo. The sidebar, landing page and account picker use the official lockup and mark from `brand.ts` (the mark is the lockup's view box cropped to the icon), and the favicons are served as on main.

**Simplified for customers (2026-10-27):**
- **One counting unit: problems.** A problem is one API change in one repository, however many lines it touches. It either breaks the code or uses a changed API and still works. The banner, sidebar, Problems page, repositories, providers, deadlines and activity all count problems; only the repository page's code map lists individual API calls.
- **Plain words.** Findings became Problems, Fix PRs became Fixes, Advisories became API changes; "affected" became "breaks", "exposed" became "still works", "call site" became "API call" or "place in your code".
- **Shorter Overview:** the banner with the health score, then "Needs your attention" beside "Coming up" (changes in the next 90 days that touch the code), then the latest fix with its proof. The number cards, timeline, provider grid and activity feed moved off it: the timeline and providers to API changes, the activity to Repositories.
- **Smaller sidebar:** Overview, Problems, Fixes, Repositories, API changes, then Settings and Billing. The Deadlines page is folded into API changes; `/deadlines` redirects to its timeline.
- The finding page lists the other places of the same problem. A test checks that two broken lines from one API change count as one problem everywhere.

