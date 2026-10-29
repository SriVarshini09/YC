# PB-12: the docs site (shapi.dev) served from Fly

## Why

The docs moved to `shapi.dev`, but GitHub Pages stopped serving them: the `YC` repository is private now, and Pages is off (`has_pages: false`). So `shapi.dev` answered "Site not found", the old `srivarshini09.github.io/YC/` address redirected there, and the web app's Privacy, Terms and Security links were broken.

## What changes

- **Built into the image:** the Docker build runs `pnpm --filter @shapi/site docs:build` and ships the result at `/app/docs`. The image has no `.git`, so pages carry no "last updated" line.
- **Served by the web process** (`apps/server/src/docs.ts`):
  - requests whose host is `shapi.dev` are served from that build, and `www.shapi.dev` gets a 301 to it;
  - those requests never reach the app's routes, so `/login` or `/github/webhook` on `shapi.dev` are just missing docs pages;
  - the app's own host, health checks and webhooks pass through untouched.
- **Files:**
  - clean URLs work (`/guide/cli` serves `guide/cli.html`, and `/legal/` serves `legal/index.html`);
  - an unknown path gets `404.html` with status 404;
  - hidden files, `..` segments, encoded escapes and NUL bytes are refused, and a resolved path must stay inside the docs folder;
  - only GET and HEAD are allowed.
- **Headers:**
  - hashed `/assets/` files are cached for a year (immutable), and pages for 5 minutes;
  - pages get their own CSP: VitePress needs `'unsafe-inline'` for its two small inline scripts and its styles, nothing loads from other origins, and the site has no cookies or forms;
  - the app's strict CSP hook now leaves a reply alone if it already has a policy.
- **Config:** `SHAPI_DOCS_URL` and `SHAPI_DOCS_DIR`, both or neither, are set in `fly.toml`.

## Needs the founder

At the DNS provider for `shapi.dev`, replace the GitHub Pages records with:

| Type | Name | Value |
|---|---|---|
| A | `shapi.dev` (apex, `@`) | `66.241.125.13` |
| AAAA | `shapi.dev` (apex, `@`) | `2a09:8280:1::1c7:933:0` |
| CNAME | `www` | `shapi-app.fly.dev` |

Leave `app` (CNAME to `shapi-app.fly.dev`) as it is. The Fly certificates for `shapi.dev` and `www.shapi.dev` are already requested (`flyctl certs add`); they're issued once DNS points at Fly.

## Verified

- `apps/server/test/docs.test.ts`:
  - pages, clean URLs and headers;
  - the immutable asset cache;
  - 404s for unknown paths and every escape attempt (the secret file next to the docs folder is never served);
  - the www redirect, and 405 for writes;
  - app routes stay off the docs host, and the app's host is untouched.
- A docs build with git unavailable (`GIT_DIR` pointing nowhere) succeeds.
- Typecheck, lint and the full test suite: results are in the PR.
