# PB-31: shapi.dev polish before launch

## Why

A pass over every page of shapi.dev, served the way production serves it (the build behind `apps/server/src/docs.ts`, with its CSP), at 1440, 1024 and 375 pixels wide. What a reviewer or a first-time visitor would notice:

- On phones and tablets the landing page's ring of API changes packed 16 cards into a ring too small for them, so they overlapped and their text ran together (from 375 up to about 1380 pixels wide).
- At 1001 to 1300 pixels wide the hero's SHAPI diagnostic was cut off by the bottom of the editor.
- The terminal section opened on an empty black box until you scrolled further.
- Every page shared the home page's description, and none had `og:title`, `og:description`, `og:url` or a canonical URL, so a shared link to the CLI reference previewed as the home page.
- Every page preloaded VitePress's bundled Inter, which the site never uses (it loads Inter Variable).
- On phones the nav's "Install on GitHub" pill is hidden, and the menu had no install link at all.
- The 404 page carried VitePress's stock quote.
- Smaller things: option names in the CLI reference broke after their dashes (`--` / `advisories <dir>`); `shapi scan [path]` headings in monospace at full heading size; docs headings at 52 px on a 375 px phone; centred eyebrows that wrap kept a rule before their first row only; log timestamps on the dark panel below 4.5:1 contrast; the GitHub icon's label said "github" though it opens the advisory database; no contact address in the footer; the security page's "Web pages run no JavaScript" read as if it meant this site.

## What changes

- **Ring of API changes:** `theme/ring.ts` works out how many cards fit side by side around the ring's radius. A phone shows 7, a 1024 px screen 11, a wide screen all 16. The rest are hidden, which also takes them out of the tab order.
- **Hero:** between 1001 and 1300 px the code column has room under line 24 for the diagnostic.
- **Terminal:** it starts with the `$ npx shapi-cli scan .` line. On narrow screens it scrolls sideways instead of cutting lines off.
- **Head tags (`.vitepress/head.ts`):** each page gets a canonical URL, `og:url`, and its own `og:title`, `og:description`, `twitter:title` and `twitter:description`. There is also an `og:image:alt`. Every page has a one-line `description` in its front matter. The legal pages only gain that front matter; their text is unchanged.
- **Fonts:** the theme extends `vitepress/theme-without-fonts`. The unused Inter preload and font faces are gone.
- **Phone menu:** it ends with an "Install on GitHub" button.
- **404:** a SHAPI message, "Go to the home page", and the number in the serif.
- **Typography:**
  - Option names in tables don't wrap.
  - Code in an h1 or h2 is 0.72 em.
  - On phones, h1 is 40 px and h2 is 28 px.
  - Landing headings and eyebrows use `text-wrap: balance`.
  - Centred eyebrows lose their rule on phones.
- **Small fixes:**
  - Log timestamps are at 55% opacity (about 5:1).
  - The GitHub link is labelled "The advisory database on GitHub".
  - The footer has `sri@shapi.dev`.
  - The security page says "Web app pages".
  - The terminal comment names 0.3.1.

## Verified

- `pnpm typecheck` and `pnpm lint` pass.
- `pnpm --filter @shapi/site docs:build` passes, with no dead links.
- `pnpm vitest run site apps/server/test/docs.test.ts` passes: 21 tests, including the new `site/test/ring.test.ts` and `site/test/head.test.ts`.
- Both builds were served by `docsSite()` from `apps/server/src/docs.ts`, so with the production headers. The pages ran with no console errors, and search works.
- Before and after screenshots, taken with headless Chrome at 375, 1024 and 1440 px, are in the review notes folder (`website-shots/`).
- The claims on the pages were checked against the code:
  - CLI flags and exit codes (`packages/cli/src`);
  - PR limits of 2 an hour and 10 open (`DEFAULT_PR_LIMITS`);
  - hourly canary and advisory-sync crons;
  - 8-hour sessions and 14-day webhook retention;
  - sandbox lifetimes of 15 and 60 minutes;
  - one free private repository (`FREE_PRIVATE_REPOS`).
- `shapi-cli scan` on `fixtures/demo-ts` prints what the landing terminal shows, apart from the fix hints and the advisory ids, which the page leaves out. `shapi-cli fix` reports all three call sites FIXED via recipe, as the page says.

## Left for the founder

- Six advisories in this repository are not in the public `shapi-advisories` repository yet, so their links on /advisories (and on the ring, while they are among the next 16) are 404s:
  - `google-gemini-2-0-flash-shutdown-sdk`
  - `google-gemini-2-5-flash-image-shutdown-sdk`
  - `google-gemini-2-5-preview-tts-shutdown-sdk`
  - `openai-assistants-threads-api-shutdown`
  - `openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14-responses`
  - `openai-legacy-gpt-o-series-shutdown-2026-10-23-responses`

  Publishing them there fixes the links.
