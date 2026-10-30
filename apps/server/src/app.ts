import Fastify, { type FastifyInstance } from "fastify";
import { ping, type Db } from "@shapi/db";
import type { Config } from "./config";
import { webhookRoutes } from "./github/webhook";
import { stripeClient, type BillingDeps } from "./billing/stripe";
import { stripeWebhookRoutes } from "./billing/webhook";
import { docsSite } from "./docs";
import { webRoutes } from "./web/routes";
import { fixtureStatuses } from "./jobs/shapes";

export interface AppDeps {
  db: Db;
  config: Pick<Config, "LOG_LEVEL" | "GIT_SHA" | "NODE_ENV" | "githubApp" | "webApp" | "billing"> &
    Partial<Pick<Config, "docs">> &
    Partial<Pick<Config, "ANTHROPIC_API_KEY">> &
    Partial<Pick<Config, "SHAPI_SHAPE_SECRET">> &
    Partial<Pick<Config, "SHAPI_RECORDINGS">>;
  /** Queue a stored webhook delivery for the worker. */
  enqueueWebhook?: (deliveryId: string) => Promise<void>;
  /** Queue a fix job on a repository's scan (a repository unpaused from the web app). */
  enqueueFix?: (scanId: string, repositoryId: string) => Promise<void>;
  /** For tests: GitHub's OAuth and API endpoints. */
  fetch?: typeof globalThis.fetch;
}

/** The web process: health, readiness, GitHub webhooks, and the web app. */
export function buildApp({ db, config, enqueueWebhook, enqueueFix, fetch }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // The docs site's own hostname first: its requests never reach the app's routes.
  if (config.docs) docsSite(app, config.docs);

  // Liveness: the process is up. Never touches the database, so a database outage doesn't restart machines.
  app.get("/healthz", async () => ({ ok: true }));

  // Readiness: the process can serve traffic (database reachable).
  app.get("/readyz", async (_req, reply) => {
    try {
      await ping(db);
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ ok: false, error: "database unavailable" });
    }
  });

  app.get("/version", async () => ({ name: "shapi", sha: config.GIT_SHA }));

  webhookRoutes(app, { db, secret: config.githubApp?.webhookSecret, enqueue: enqueueWebhook ?? (async () => {}) });
  const billing: BillingDeps | undefined = config.billing ? { db, stripe: stripeClient(config.billing, { fetch }), config: config.billing } : undefined;
  stripeWebhookRoutes(app, { billing });
  const { SHAPI_RECORDINGS: recordings, SHAPI_SHAPE_SECRET: secret } = config;
  const fixtures = recordings && secret ? () => fixtureStatuses(db, recordings, secret, new Date()) : undefined;
  webRoutes(app, { db, config: config.webApp, fetch, billing, enqueueFix, llmAvailable: Boolean(config.ANTHROPIC_API_KEY), feedbackSecret: config.SHAPI_SHAPE_SECRET, fixtures });

  return app;
}
