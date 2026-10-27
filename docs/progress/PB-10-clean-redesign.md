# PB-10 clean redesign: website and web app

What exists: the docs site and the web app share one look, signed off on `brand/redesign-mockup.html` (open it in a browser; the switch at the bottom flips between the website and the dashboard). It replaces the dark navy-and-blue look.

**The look**
- **Colours:** the logo's Paper `#F7F6F2` and Ink `#0E0F12`, with white cards and thin warm lines. Red `#C2412D` appears only where something breaks, green `#2D7A52` only where it's fixed, and amber `#A86A12` for what's coming soon. No gradients and no blue.
- **Type:** headlines in Jost Light, text in Inter, and code with ligatures off. Both fonts come from `@fontsource-variable`. The web app serves them itself (`/static/jost.woff2`), because its CSP allows only `font-src 'self'`.
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
