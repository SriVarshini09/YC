# PA-A6c web app dashboard redesign

What exists: the web app is a dashboard with a fixed dark-navy sidebar and a light main area of white cards on a pale blue-gray background (blue accent, Inter, rounded cards, soft shadows, hover states), with a dark theme. Still server-rendered with **no client JavaScript**: charts are inline SVG, tooltips are `<title>` elements and CSS, and the theme is a cookie the shell reads.

**Pages** (all under `/a/<account>`; the sidebar shows live counts):
- **Overview**: API health ring (share of third-party call sites that still work, less a little per affected call site by severity and per failed scan; "Healthy" only with nothing affected), four stat cards (affected call sites, fixes merged, deadlines in 90 days, providers watched), the deadline timeline (next 180 days, red to 30 days, amber to 90, green after; changes already in effect stacked at day 0), a provider grid with monogram marks and green/amber/red status, and a recent activity feed (scans, PRs opened/merged/closed, new affected call sites).
- **Repositories**: every repository with providers, affected/exposed counts, fix PRs and last scan.
- **Repository**: a health strip, then every call site grouped by provider from the latest `api.lock` (plus any finding the lock does not list); affected rows highlighted, each linking to its finding and fix PR. Fix PRs and recent scans below. Pause/resume as before.
- **Finding** (`/f/<id>`, new): what changed (summary, endpoint, dates, provider notice, sources, migration note), where in the code and why it is affected, **expected vs actual** (derived from the advisory's trigger/fix and the call site's surface: status codes, renamed fields, enum values, pinned versions), and **the fix**: the four verification steps, the contract test **failing before and passing after** (vitest output in a disclosure), and the unified diff per file.
- **Findings**, **Fix PRs**, **Deadlines**, **Advisories** (54 reviewed changes, providers in the code first, filter by provider), **Settings** (moved off the account page), **Billing** (plan cards; Stripe return URLs now land here). The "cancels on" date from PB-7 is not on this page yet: its `billing.cancel_at` column is not on main. Whichever of the two lands second adds `cancel_at` to the billing select in `queries.ts` and the date to the plan card, and renumbers its migration to 0008.
- Sign-in and the account picker are a centered card; one account goes straight to its overview (`/?all` lists them).

**Data for the finding page**: migration `0007_fix_pr_repair` adds `fix_prs.repair` (jsonb). The fix job stores a `FixRepair` with the PR: method, recipe, sandbox, each call site's test file with its before/after run (verdict, vitest count, output tail), and a unified diff per file cut at 400 lines. Written when the PR is created or updated; an unchanged PR keeps what it had. PRs from before the migration show "details on the PR".

**Security**: unchanged rules, checked by tests. CSP stays `default-src 'none'` with no scripts; `font-src 'self'` is added because Inter is served from this origin (`@fontsource-variable/inter`, latin subset). The CSP forbids inline `style=` attributes, so none are used (a test asserts this on every page). Forms keep the CSRF token (theme switch included); every value is escaped; tenant isolation covers the new finding route (another account's finding id is a 404). The stylesheet URL carries a content hash so a deploy never serves an hour-old cached sheet.

**Preview**: `pnpm build && pnpm --filter @shapi/server preview` starts a throwaway Postgres with a seeded demo account (five repositories, locks, findings, fix PRs with verification) on http://localhost:8788/preview/login (`?theme=dark`), with no GitHub or Stripe. Used for the screenshots.

Every page fits a 375-pixel phone screen without sideways scrolling (checked in a real browser; headless Chrome cannot render narrower than about 500 pixels, so its phone screenshots look cropped).

Verified: typecheck, lint, and the suite pass (web tests cover every page, the theme cookie, no inline styles, the finding page's comparison and PR link, and cross-tenant 404; fix delivery tests cover storing and keeping the repair summary; a unit test covers the summary and diff cut).

Not done: real provider logos (the marks are colored monograms, drawn here, so nothing is loaded from elsewhere and no trademarked artwork ships); charts beyond the ring and the timeline.
