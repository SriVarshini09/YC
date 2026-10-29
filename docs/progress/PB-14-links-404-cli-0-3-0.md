# PB-14: no links to the private repository, an HTML 404, robots.txt, and shapi-cli 0.3.0

## Links to the private repository

The `YC` repository is private, so every link to it was a 404 for visitors:
- the docs' "Edit this page" link and their GitHub icon;
- the legal pages' contact ("open an issue"), page-history links and the CLI license link;
- the security page's reporting route;
- the agents guide's `git clone`;
- the fix PRs' "Opened by SHAPI" footer;
- the npm package's repository and bugs links.

Now (the founder chose `sri@shapi.dev` as the contact):

| Where | Now |
|---|---|
| Docs header | The GitHub icon links to the public `shapi-advisories` repository, and "Edit this page" is gone |
| Privacy, DPA, terms, subprocessors | Requests go to `sri@shapi.dev`, with subjects "Privacy request", "DPA request" and "Security"; public questions go to `shapi-advisories` issues. History links are replaced by "changes are posted on this page, with the date at the top". All four are dated October 29, 2026. |
| Terms | The CLI is "licensed under the Apache License 2.0", linking to the `LICENSE` file in the npm package (unpkg) |
| Security | Vulnerabilities are reported by email to `sri@shapi.dev`, subject "Security" |
| GitHub App guide | Problems go to `shapi-advisories` issues or by email |
| Agents guide | Agents can use the CLI today (`npx shapi-cli`, never `shapi`). The MCP server and skill are a preview available on request, since they run from the private source. |
| Fix PR footer, GitHub App manifest homepage | `https://shapi.dev` |
| npm package | No repository field; bugs go to `shapi-advisories` issues and `sri@shapi.dev`; the README links `app.shapi.dev` |

## App polish

- **404 page:** unknown addresses on `app.shapi.dev` now get an HTML "Page not found" page with a link home, for browsers (GET or HEAD that accept HTML). Everything else, such as webhook senders and scripts, still gets Fastify's JSON 404.
- **`robots.txt`:**
  - the app's keeps `/a/`, `/auth/` and `/login` out of search engines;
  - the docs ship a `robots.txt` and a `sitemap.xml` for `https://shapi.dev`.

## shapi-cli 0.3.0

The version goes from 0.2.0 to 0.3.0: `packages/cli/package.json`, `VERSION`, and the demo `api.lock` generator line. It adds features, not just fixes. Since 0.2.0:
- the title and "Next" steps;
- the `shapi-cli` command name (PB-13);
- the scanner detection gap work, including "possibly affected" (PB-11).

The homepage terminal sample shows 0.3.0's real output on the demo, shortened. Publishing needs the founder's npm approval after merge.

## Verified

- `web.test.ts`: the HTML 404 page, JSON for non-browsers, and `robots.txt`.
- The docs build has no link to the private repository, and has `robots.txt` and `sitemap.xml`.
- Typecheck, lint, the full test suite and the npm packaging smoke test (`pnpm pack:cli`): results are in the PR.
