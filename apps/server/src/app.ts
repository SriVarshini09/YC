import Fastify, { type FastifyInstance } from "fastify";
import { ping, type Db } from "@shapi/db";
import type { Config } from "./config";
import { webhookRoutes } from "./github/webhook";

export interface AppDeps {
  db: Db;
  config: Pick<Config, "LOG_LEVEL" | "GIT_SHA" | "NODE_ENV" | "githubApp">;
  /** Queue a stored webhook delivery for the worker. */
  enqueueWebhook?: (deliveryId: string) => Promise<void>;
}

/** The web process: health, readiness and GitHub webhooks; the API arrives in later tasks. */
export function buildApp({ db, config, enqueueWebhook }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

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

  return app;
}
