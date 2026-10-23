# PA-A9 deploy to Fly.io

What exists: SHAPI runs on Fly.io as **shapi-app** (https://shapi-app.fly.dev), with its database on Neon.
- **Fly:** the app `shapi-app` in the founder's Fly account (paid from Fly credits), region `iad`, one web and one worker machine (shared-cpu-1x, 512 MB). The name `shapi` was already taken on Fly.
- **Neon:** project `shapi` in AWS US East (N. Virginia), Postgres 18, connected directly (not through Neon's pooler, because each connection switches to the `shapi_app` role so row-level security applies). The owner role can create roles, which the first migration needs.
- **Secrets on Fly:** `DATABASE_URL`, `SHAPI_SHAPE_SECRET` and `SHAPI_SESSION_SECRET` (both random, 32 bytes) and `E2B_API_KEY`. None were printed or written to disk: the database URL went through a hidden prompt that tested the connection first.
- `fly.toml` now names `shapi-app` and sets `SHAPI_PUBLIC_URL`.
- **Production GitHub App:** **SHAPI by SriVarshini** (https://github.com/apps/shapi-by-srivarshini), public, created with the manifest flow: `node apps/server/dist/register.js --name SHAPI --public --webhook-url https://shapi-app.fly.dev/github/webhook --callback-url https://shapi-app.fly.dev/auth/github/callback --out .shapi/prod`. GitHub confirmed the permissions (contents, pull requests, checks and issues: write; metadata: read) and the events (push, pull_request, issues). Its six settings are Fly secrets, and the local copy is in the git-ignored `.shapi/prod/`. The test app `shapi-dev-sv` is unchanged.
- The registration script has a new `--callback-url` option, so the manifest sets the web app's sign-in callback (`callback_urls`), with a test.

Not connected yet:
- **Stripe:** no keys on the server yet, so every repository is covered. Webhooks to the deployed server come with the real price.
- **Automatic deploys:** the Deploy workflow skips until the `FLY_API_TOKEN` repository secret is set.

Verified on the live server (first deploy from this branch, `flyctl deploy --remote-only`):
- The release command ran the migrations on Neon, then one web and one worker machine started in `iad`.
- `GET /healthz` returns `{"ok":true}`, the home page returns 200, and the Fly health check passes.
- The worker logged `worker started`, then `advisories synced` with 7 advisories written from `SriVarshini09/shapi-advisories`, then the fan-out (0 repositories so far).
- Before the GitHub App, `POST /github/webhook` answered 503. With it, an unsigned request gets 401, the home page links to `github.com/apps/shapi-by-srivarshini/installations/new`, and the worker logs `githubApp: true`.

pg prints a warning that `sslmode=require` is treated as `verify-full`. That is the stricter behavior, so nothing needs to change now.

```
fly status -a shapi-app
fly logs -a shapi-app
```
