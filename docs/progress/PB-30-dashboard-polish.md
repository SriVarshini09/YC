# PB-30 dashboard polish

## Why

A page-by-page pass over the signed-in dashboard, the message pages and the landing page, in light and dark, at desktop and phone widths, looking for what a designer or a first-time customer would flag before launch. The demo preview (`pnpm --filter @shapi/server preview`) was the test bed.

## What changes

**Layout**
- **Repository page:** the Fixes table sat in a half-width column and its Updated column was cut off. Fixes and Recent scans now stack at full width.
- **Tables:** every table card scrolls sideways when its columns are wider than the card, instead of cutting them off. Column headers no longer wrap ("Takes effect" took two lines), and "Updated"/"When" times stay on one line.
- **Finding page:** the facts table's labels ("Type of change", "Provider notice") fit on one line and line up with the card's heading. "Test result" and "Diff" get space above them.
- **API changes:** the provider cards are a little wider, with the status on one line and the API call count under it, so the cards no longer wrap to three uneven lines.
- **Overview:** the arrow on "n more items" showed at zero width; it shows now.
- **Scanning page:** the pulse sits beside the headline, as the Overview's status dot does.
- **Settings:** "Slack alerts" is spaced apart from the Pull requests fields.
- **Landing page:** the Free and Team price buttons line up at the bottom of their cards. The hero's code card clipped line 23 mid-word; that line is shortened with "…", as line 13 already is.

**Phones (under 900 px)**
- The account switch, Sign out and the theme buttons were hidden, so a phone user couldn't sign out, switch accounts or change the theme (and Settings told them to use buttons they couldn't see). They now show in the top bar.
- The icon-only menu kept its labels for screen readers: they were `display: none`, which left the links with no name.
- The repository's call-site table used fixed column widths for five columns while showing three, so it filled two thirds of the card. It sizes to its three columns now.

**Keyboard and screen readers**
- There was no focus style. Every link, button, input and summary now shows a 2 px ring on keyboard focus, drawn inward inside lists and in the page colour on an ink pill.
- A "Skip to content" link comes first on every account page.
- The current page in the menu has `aria-current="page"`, the chosen theme button has `aria-pressed`, and breadcrumbs are a labelled `nav`.

**Contrast**
- Small uppercase labels (table headers, the repository strip, "Expected by the code", eyebrows) used `--faint`, about 3:1 in both themes. They use `--muted` now (4.7:1 or better).
- Light theme: `--ok`, `--warn` and `--bad` are a shade darker, so tag text reaches 4.5:1 on its tinted background (from 4.2 to 4.4).
- Dark theme: the setup checklist's tick and the timeline's "already in effect" count were white on light green and light red (1.9:1 and 2.8:1). They use the page colour now.

**Wording and dead ends**
- A missing repository or problem inside an account showed "Not found. Nothing here." with no way back. It now says what may be wrong and links back to the account's overview.
- API changes: providers your code doesn't call were marked by a stray " ·" after their name in the filter. They are a dashed pill with the tooltip "Not called from your code".
- Fixes table: the repository showed twice in each row (under the PR and under the problem). The problem line names the provider only.
- Provider monograms: "Atlassian (Jira, Confluence)" showed "A(" and "X (Twitter)" "X(". The aside in brackets is ignored: "At" and "X".
- Billing: "adding them never raises it without this button" referred to a button that is not always there. It now says adding repositories raises the plan only when you click to add them here.
- Settings: "theme buttons at the bottom of the sidebar" is now "the Theme buttons under your name in the sidebar", which is true on a phone too.

**Preview script**
- `?as=member` signs in a user who can read every repository but is not an admin and can't push (no Settings, Billing or pause button).
- Account 4 (`quietco`) is scanned with nothing breaking, for the all-clear Overview and the empty Problems and Fixes pages.

## Verified

- `pnpm typecheck`, `pnpm lint` and `pnpm vitest run apps/server/test/web.test.ts` (45 tests) pass. New tests in "dashboard polish": the account-level not-found page, the skip link, `aria-current`, `aria-pressed`, the breadcrumb label and the focus ring, the provider filter marking, and the monograms.
- Screenshots of every page before and after, in light and dark, at 1440 px, 500 px and 375 px, through the preview: no page scrolls sideways at any of those widths.
