# PA-A1 backend foundation

What exists: `packages/db` is the Postgres layer, built with Kysely and pg. It has one migration with accounts, repositories, scans, findings, advisories, observations and webhook_deliveries. Tenant tables use forced row-level security: connections run as the `shapi_app` role, `withTenant` scopes a transaction to one account, and `withService` is for system jobs. `PgShapeStore` implements the new `ShapeRepository` interface, which the canary now uses for both SQLite and Postgres. Advisory sync never lets a canary draft overwrite a reviewed advisory. `apps/server` has two processes. The web process is Fastify with `/healthz`, `/readyz` and `/version`. The worker uses pg-boss: an hourly canary run that files drafts, plus an advisory sync on start. Config is validated with zod, and Sentry is optional and strips request and user data.
Shipping: one Docker image runs web, worker and migrate. `fly.toml` runs migrations before each deploy. CI on every PR runs lint, typecheck and tests, then builds the image and smoke-tests it against Postgres 17. `deploy.yml` deploys main to Fly.io and skips until a `FLY_API_TOKEN` secret exists.
Verified: 137 tests pass. 15 are new, run against a real embedded Postgres, and include cross-tenant reads and writes being refused. The image was built and run locally: migrate applied, `/readyz` answered ok, and the worker synced 7 advisories.
Not done: a live deploy. That needs a Fly.io account and a Postgres host, Neon or Fly Managed Postgres.

```
pnpm test
docker build -t shapi-server .
DATABASE_URL=postgres://... node apps/server/dist/migrate.js
DATABASE_URL=postgres://... node apps/server/dist/web.js
DATABASE_URL=postgres://... node apps/server/dist/worker.js
```
