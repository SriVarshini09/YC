import { PgBoss } from "pg-boss";
import type { Db } from "@shapi/db";
import type { Config } from "./config";
import { syncAdvisoriesJob } from "./jobs/advisories";
import { runCanaryJob } from "./jobs/canary";

/** Every queue the worker handles. Names are stable: they live in the database. */
export const QUEUES = {
  canaryRun: "canary-run",
  advisoriesSync: "advisories-sync",
} as const;

export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  /** Connection string for pg-boss (runs as the owner: it manages its own `pgboss` schema). */
  databaseUrl: string;
  /** App-role database client for job bodies. */
  db: Db;
  config: Pick<Config, "CANARY_CRON" | "SHAPI_ADVISORIES" | "canaryProviders">;
  env: Record<string, string | undefined>;
  log: Logger;
  fetch?: typeof globalThis.fetch;
}

/**
 * Start pg-boss, create the queues, register handlers and the canary schedule. Jobs are durable
 * (stored in Postgres), retried with backoff, and a scheduled job runs once even with many workers.
 */
export async function startWorker(deps: WorkerDeps): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: deps.databaseUrl, application_name: "shapi-worker" });
  boss.on("error", (err) => deps.log.error({ err }, "pg-boss error"));
  await boss.start();

  await boss.createQueue(QUEUES.canaryRun, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 });
  await boss.createQueue(QUEUES.advisoriesSync, { retryLimit: 3, retryDelay: 10, retryBackoff: true });

  await boss.work(QUEUES.advisoriesSync, async () => {
    const written = await syncAdvisoriesJob(deps.db, deps.config.SHAPI_ADVISORIES);
    deps.log.info({ written }, "advisories synced");
    return { written };
  });
  await boss.work(QUEUES.canaryRun, async () => {
    const result = await runCanaryJob({ db: deps.db, env: deps.env, providers: deps.config.canaryProviders, fetch: deps.fetch });
    deps.log.info(result, "canary run finished");
    return result;
  });

  if (deps.config.CANARY_CRON) await boss.schedule(QUEUES.canaryRun, deps.config.CANARY_CRON);
  else await boss.unschedule(QUEUES.canaryRun);

  // Reviewed advisories may have changed with this deploy.
  await boss.send(QUEUES.advisoriesSync, {});
  return boss;
}
