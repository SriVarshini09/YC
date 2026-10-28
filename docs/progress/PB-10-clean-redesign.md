# PB-10 clean redesign: website and web app

What exists: the docs site and the web app share one look, signed off on `brand/redesign-mockup.html` (open it in a browser; the switch at the bottom flips between the website and the dashboard). It replaces the dark navy-and-blue look.

**The look** (later passes replaced these colours; the current one is "Stone and Ink" at the end)
- **Colours:** Butter `#FFD84A` and Ink `#17130A`, on a cream page `#FCF8EC` for reading. Red `#C2412D` appears only where something breaks, green `#2D7A52` only where it's fixed, and amber `#A86A12` for what's coming soon. No gradients and no blue.
- **Type:** headlines in Jost SemiBold, text in Inter, and code with ligatures off. Both fonts come from `@fontsource-variable`. The web app serves them itself (`/static/jost.woff2`), because its CSP allows only `font-src 'self'`.
- **Shapes:** pill buttons, small spaced-out labels with a rule, and numbered sections.

**Motion.** All of it explains the product, and all of it is off under `prefers-reduced-motion`:
- The hero's code card loops: works → GitHub changes → line 15 breaks → SHAPI types the fix → fixed.
- A slow strip of the next real API deadlines (website) or the watched providers (app).
- Headlines fade up as they scroll in. On the website, the words of each problem light up one by one.
- A pulsing status dot on the Overview.

**Website (`site/`)**
- **Landing page:** a single component, `theme/components/Home.vue`. Its sections are the hero and story card, the deadline strip, the numbers, the problem (01–03), how it works, the CLI output, the next 8 deadlines, what a fix PR contains, pricing, security and the call to action.
- **Data:** numbers and deadlines come from `advisories.data.ts`, as before. Deadlines start from tomorrow, so the list never fills up with changes that take effect today.
- **Without JavaScript:** the content is visible. The fade-in only hides content once the script has run.
- **Light only:** `appearance: false`. The docs pages pick up the palette and the Jost headings through VitePress's variables.
- **Nav:** How it works · API changes · Docs · Security, and an "Install on GitHub" pill.

**Web app (`apps/server/src/web/`)**
- **`styles.ts`:** rewritten on the same palette. The old token names are kept, so every page changes. The sidebar is light, and the active page is a white card.
- **Theme:** Light is the default for everyone, Auto included. Dark applies only when picked, in warm ink tones. The picker shows Light and Dark.
- **Overview:** leads with one sentence, "N problems need you." or "All clear.", with the pulsing dot and a one-line breakdown. The sections from PA-A6d are unchanged, and no data or queries changed.
- **Landing (`landing.ts`):**
  - The same hero and a CSS-only story card.
  - The provider strip, the numbered problem, and four steps (map, match, fix, watch).
  - Coverage, proof, security and pricing are restyled.
- Still no client JavaScript and no `style=""` attributes.

Verified:
- `pnpm typecheck` and `pnpm lint`: clean.
- `pnpm test`: 39 files, 274 tests passed.
- `docs:build`: passed.
- Website: in the browser pane, desktop and phone (375 px, `scrollWidth` 375), the scroll reveals and the story loop. A docs page in headless Chrome.
- Web app: the demo preview, covering the landing (both story states), Overview, Problems, a problem page and dark mode on desktop, and the same pages at 400 px with no sideways scroll.

## Scrolling (second pass)

**Website.** `site/.vitepress/theme/components/Home.vue` and `home.css`, the landing styles moved out of `custom.css`.
- **How it works:** a pinned stage with four chapters that play as you scroll past their text:
  1. **Map:** three call sites appear, wires draw to their APIs, and the API pills land.
  2. **Match:** GitHub's wire turns red, the call is tagged "breaks", and the change notice rises.
  3. **Fix:** line 15 types itself from the old check to the new one as you scroll, and a log fills in: test fails, recipe applied, test passes.
  4. **Watch:** the pull request card slides up, and a radar names the next real deadline.

  The stage follows whichever chapter title is at the middle of the screen, so the text and the picture always match. On phones the stage pins above the text.
- **The problem:** each heading lights up word by word as it crosses the screen, and "production." lights up last, in red.
- **Numbers:** they count up as they scroll in.
- **Deadlines:** a pinned calendar of the next 10 changes moves sideways while the page scrolls down, from a "Today" marker. A line fills to show how far along you are.
- **Other sections:** the hero drifts up and fades as you leave it, and a reading-progress line runs under the nav. The terminal tilts in and prints its findings line by line. Checklist ticks draw as each item crosses. The two pieces of the logo fit together at the close.
- **Without the script or with reduced motion:** every scroll value defaults to 1, the finished state. The deadline calendar becomes a normal sideways-scrolling list.

**Web app landing.** `apps/server/src/web/landing.ts` and `styles.ts`, still without scripts:
- **CSS scroll timelines:** `animation-timeline: view()` and `scroll()`, inside `@supports`.
- **What moves:** a progress line, the hero drifting away, rising headlines, and the problem lines in sequence. The provider strip shifts with the scroll, and the proof diff strikes out the broken line and writes the fix as you scroll through it.
- **Other browsers:** they get the page as before.

Verified:
- `pnpm typecheck` and `pnpm lint`: clean.
- `docs:build`: passed.
- `pnpm test`: 39 files, 274 tests. One run reported a file failure with every test passing, and two reruns were fully green.
- Real-time headless Chrome screenshots at each chapter, the calendar and the close, on desktop (1366 px) and phone (390 px). No sideways scroll, no console errors.

## Butter (third pass)

The founder found the paper-and-grey look too quiet and picked option B of four colour directions (`brand/colour-directions.html`: Highlighter, Butter, Tangerine, Forest).
- **Website landing:** the whole page is Butter yellow, nav included. The deadline ticker and the closing call to action are ink bands, while "How it works" and pricing sit on cream bands. Headlines are Jost SemiBold, and "keeps working." gets a red underline that draws in on load. Cards are white, with a 2 px ink edge and a hard ink shadow, and the buttons are ink pills with Butter text.
- **Docs pages:** a cream page with bold headings. Links are underlined in Butter, inline code sits on light Butter, and the current page in the sidebar is a Butter pill.
- **Web app:** the sidebar is Butter, and the current page is an ink pill. Cards have an ink edge and a hard shadow, the primary buttons are ink with Butter text, and the numbers are SemiBold. The app's landing matches the website (`.under` is the underline). Dark mode keeps its warm ink set, with Butter as the accent.
- **Fixed:** the app landing's code card was showing `===` as a ligature, because the `font:` shorthand reset `font-variant-ligatures`.

Verified:
- `pnpm typecheck` and `pnpm lint`: clean.
- `docs:build`: passed.
- `pnpm test`: 274 of 274 tests passed, though `cloud.test.ts` reported a file-level failure in the full run. On its own (with `web.test.ts`), 34 of 34 passed.
- Headless Chrome screenshots: the landing (desktop and 390 px phone, no sideways scroll), a docs page, the app landing, Overview and Problems.

## Stone and Ink (fourth pass, website only so far)

The founder found Butter too loud. They chose Stone and Ink from seven palettes in `brand/palette-studio.html` and asked for the website first; the web app still has Butter.
- **Colours:** stone `#F1F1EE`, surface `#FAFAF8`, ink `#121212`, muted `#6B6B66`, tint `#E4E4DF`. Red `#C0392B` only where something breaks, green `#3F7A55` only where it is fixed. Logs and terminals are ink panels, with brighter red, green and amber for text on them.
- **Type:** headlines in Instrument Serif, with the second half of a headline in grey italic. Text stays in Inter, and code keeps ligatures off. `@fontsource/instrument-serif` replaces Jost on the site.
- **Landing (`Home.vue`, `home.css`):** every picture is a real SHAPI artifact. Each section pins while you scroll through it:
  1. **Hero:** the demo project's `deploy.ts` in an editor, with threads from GitHub, Stripe, HubSpot and QuickBooks to the files that call them. Line 22 breaks with SHAPI's diagnostic, the contract test fails, the fix types in, the test passes, and "PR #2 opened" appears.
  2. **The problem:** the GitHub story lights up word by word.
  3. **How it works:** Map, Watch, Match, Fix and Ship, each beside the real artifact: the `api.lock` entry, the canary's shape diff, the advisory matched to `api.lock`, the diff with its test runs, and PR #2 with its evidence table.
  4. **The API changes:** the next 16 real changes on a turning ring. The loader now also passes each advisory's `changeClass`.
  5. **The same morning, two ways:** production logs without and with SHAPI, which flip halfway or with the switch.
  6. **Terminal:** the real `shapi scan` output, printed as you scroll. The HubSpot deadline counts down from the build date.
  7. **Pricing and code handling,** then the logo's two pieces, "your code" and "the API", fitting together.
- **Smooth scrolling:** Lenis, loaded only on the landing page and removed when you leave it.
- **Reduced motion:** the page still follows the scroll, but nothing moves on its own.
- **Docs pages:** serif headings, ink links with a quiet underline, and the current page in the sidebar on a tint pill.

Verified:
- `pnpm typecheck` and `pnpm lint`: clean.
- `docs:build`: passed.
- Headless Chrome screenshots, with no console errors and no sideways scroll:
  - **Desktop (1440 × 900):** every hero phase and every section.
  - **Phone (390 × 844):** the hero, the pinned screens, the ring, the logs, the terminal, pricing and the close.
  - **Docs pages:** quickstart (desktop and phone), how it works, advisories and security.

## Accuracy pass (before the YC submission)

Every claim on the website was checked against the code, the real CLI output and the real shapi-demo PR #2.

**Landing page**
- **Hero:**
  - The contract test now passes only once line 22 is fully rewritten.
  - The match step flags all three real findings: GitHub critical, QuickBooks and HubSpot high. Stripe shows "✓ not affected" in green.
  - The lede says fixes come "where a fix recipe exists".
- **How it works:**
  - The canary pane uses relative times. The demo's shapes come from a recording, so the pane makes no claim about a live detection on a real date.
  - PR #2 is shown as merged, and the PR limit is "by default".
  - "Probe every hour" matches `CANARY_CRON`.
- **The logs section** is labelled "illustration".
- **The terminal** says its output is shortened.
- **Code-handling bullets:** they now mention the stored fix diffs, and the network is described as off before code or tests run.

**Docs pages** (corrected from an audit against the code)
- **Install network:** install scripts run while the package registries are reachable, and the network is cut before code or tests run. Fixed in fixes, security and DPA.
- **Stored data:** fix diffs and contract-test output are stored. Fixed in security, privacy and DPA.
- **Claude:** it also receives the failing test output. Fixed in security, privacy, subprocessors and fixes.
- **Cookies:** the web app sets three cookies (theme included), and the docs site has no theme switch. Fixed in privacy.
- **Retention:** webhook payloads are kept 14 days after processing, and billing ids are kept while installed.
- **CLI:** exit codes for unknown options, `GH_TOKEN`, and what `fix` prints for call sites it can't fix.
- **Other corrections:**
  - The HubSpot tense (Dec 4, 2026 is still ahead).
  - The pricing wording on the GitHub App page.
  - The placeholder source in the advisory example.
  - "© 2026 SHAPI".
- **Legal pages:** marked last updated October 28, 2026.

Verified:
- **Links:** 36 internal links, none missing. 77 of 80 external links return 200; the other 3 are GitHub history pages that rate-limited the check.
- **Pages:** the whole landing page in headless Chrome at 1440 and 390 px, with no console errors and no sideways scroll.
- **Checks:** typecheck, lint and `docs:build` pass.

## Web app in Stone and Ink

The web app (`apps/server/src/web/`) now matches the website.
- **Colours** (`styles.ts`):
  - Stone and Ink tokens: a stone sidebar, the current page as an ink pill, and ink primary buttons.
  - Cards have a thin line border and a soft shadow, with no hard ink edge.
  - Red only where code breaks, amber for high and coming soon, and green only where it's fixed.
  - Dark mode is an ink set with stone type, still applied only when picked.
- **Type:** headlines, numbers and the health score are in Instrument Serif. The app serves the serif itself (`/static/serif.woff2` and `/static/serif-italic.woff2` from `@fontsource/instrument-serif`), so the CSP is unchanged. Jost is gone.
- **Landing (`landing.ts`):**
  - The serif headline has "Your code keeps working." in grey italic.
  - The story card and the proof diff now show the demo project's real `src/deploy.ts`, line 22, and the real fix from shapi-demo PR #2, with a link to it.
  - The provider strip and the closing section are light, not ink bands.
- **Accuracy:**
  - The landing now says SHAPI *recognizes* calls to 35 APIs, which is the registry the scanner matches, rather than "watching" them.
  - The Watch step says canaries probe every hour and that announced changes are researched from changelogs.
  - Settings no longer says the theme follows the system; light is the default.
- **Still true:** no client JavaScript, no `style=""` attributes.

Verified:
- **Static checks:** `pnpm typecheck` and `pnpm lint` are clean.
- **Tests:** `pnpm test` passes, 39 files and 275 tests.
- **Demo preview at 1440 px:** the landing, Overview, Problems, a problem page, Fixes, Repositories, API changes, Deadlines and Settings in light mode. Overview, Problems, a problem page and Fixes in dark mode.
- **Phone (375 px):** the landing, Overview and Problems, with `scrollWidth` 375 and no sideways scroll.
- **Fonts:** both serif files are served with `font/woff2`.
