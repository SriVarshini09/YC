import Fastify, { type FastifyInstance } from "fastify";
import { ping, type Db } from "@shapi/db";
import type { Config } from "./config";

export interface AppDeps {
  db: Db;
  config: Pick<Config, "LOG_LEVEL" | "GIT_SHA" | "NODE_ENV">;
}

/** The web process: health and readiness now; GitHub webhooks and the API arrive in later tasks. */
export function buildApp({ db, config }: AppDeps): FastifyInstance {
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

  return app;
}
