# PA-A9 deploy to Fly.io

What exists: SHAPI runs on Fly.io as **shapi-app** (https://shapi-app.fly.dev), with its database on Neon.
- **Fly:** the app `shapi-app` in the founder's Fly account (paid from Fly credits), region `iad`, one web and one worker machine (shared-cpu-1x, 512 MB). The name `shapi` was already taken on Fly.
- **Neon:** project `shapi` in AWS US East (N. Virginia), Postgres 18, connected directly (not through Neon's pooler, because each connection switches to the `shapi_app` role so row-level security applies). The owner role can create roles, which the first migration needs.
- **Secrets on Fly:** `DATABASE_URL`, `SHAPI_SHAPE_SECRET` and `SHAPI_SESSION_SECRET` (both random, 32 bytes) and `E2B_API_KEY`. None were printed or written to disk: the database URL went through a hidden prompt that tested the connection first.
- `fly.toml` now names `shapi-app` and sets `SHAPI_PUBLIC_URL`.

Not connected yet:
- **GitHub App:** the existing `shapi-dev-sv` app still points at smee for local development. Production gets its own GitHub App with the webhook at `https://shapi-app.fly.dev/github/webhook`.
- **Stripe:** no keys on the server yet, so every repository is covered. Webhooks to the deployed server come with the real price.
- **Automatic deploys:** the Deploy workflow skips until the `FLY_API_TOKEN` repository secret is set.

Verified on the live server (first deploy from this branch, `flyctl deploy --remote-only`):
- The release command ran the migrations on Neon, then one web and one worker machine started in `iad`.
- `GET /healthz` returns `{"ok":true}`, the home page returns 200, and the Fly health check passes.
- The worker logged `worker started`, then `advisories synced` with 7 advisories written from `SriVarshini09/shapi-advisories`, then the fan-out (0 repositories so far).
- `POST /github/webhook` answers 503, as designed until a GitHub App is configured.

pg prints a warning that `sslmode=require` is treated as `verify-full`. That is the stricter behavior, so nothing needs to change now.

```
fly status -a shapi-app
fly logs -a shapi-app
```
