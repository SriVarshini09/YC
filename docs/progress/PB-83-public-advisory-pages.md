# PB-83: Public advisory pages, Markdown twins, provider JSON, iCal and llms.txt (execution plan G-04)

## Why

The advisories were one table on shapi.dev. A developer searching for a specific change should land on a page about it. Tools should be able to fetch one provider's advisories, calendars should hold the deadlines, and coding agents read Markdown and llms.txt.

## What changes

- **A page per advisory** at `shapi.dev/advisories/<id>` (VitePress dynamic route `site/advisories/[id]`):
  - provider, endpoint, effective date, severity, change class, status and automatic fix;
  - what changed, what to do, and sources;
  - the scan command;
  - links to the Markdown, OSV and JSON versions.

  Values come in through Vue bindings, which escape them. Only the H1 is literal, escaped, because VitePress takes the page title from it.
- **Markdown twins** at `/advisories/<id>.md`. `site/scripts/advisory-twins.ts` writes them into the built site after `vitepress build`, because VitePress would compile any `.md` under `site/`, `public/` included, as a page.
- **Per-provider JSON** at `/api/v1/providers/<provider>.json`: every advisory, soonest first, with page, Markdown and OSV links. It is served to any origin.
- **`/deadlines.ics`:** one all-day event per advisory on its effective date. It follows RFC 5545: CRLF line endings, lines folded at 75 octets, escaped text, and stable UIDs and DTSTAMPs.
- **`/llms.txt`** (llmstxt.org): what SHAPI is, the docs pages with their descriptions, each provider's JSON, the deadlines feed, and every advisory's Markdown twin.
- **The server** serves `.md` as `text/markdown` and `.ics` as `text/calendar`.
- **Docs:** "How SHAPI works" lists all of it.
- **No shared files touched.** The table page `site/advisories.md` and the VitePress config are unchanged, since another session has unmerged edits to them.

## Verified

- **The generators (core):** stable per-provider order and links; llms.txt structure, with an entry for every advisory; an iCal feed with CRLF, ≤ 75-octet lines and one VEVENT per advisory.
- **The published files in `site/public` are in sync** (`UPDATE_PUBLIC=1` rewrites them).
- **The docs build** produces 87 advisory pages and 87 Markdown twins, with real titles.
- **Server tests:** content types, and CORS on `/api/`.
