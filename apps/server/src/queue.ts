import { PgBoss } from "pg-boss";
import type { Db } from "@shapi/db";
import type { Config } from "./config";
import { githubClients } from "./github/clients";
import { processDelivery } from "./github/events";
import { syncAdvisoriesJob } from "./jobs/advisories";
import { runCanaryJob } from "./jobs/canary";
import { sweepWebhooks } from "./jobs/webhook-sweeper";

/** Every queue the worker handles. Names are stable: they live in the database. */
export const QUEUES = {
  canaryRun: "canary-run",
  advisoriesSync: "advisories-sync",
  githubWebhook: "github-webhook",
  webhookSweep: "webhook-sweep",
} as const;

export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Create (or update) every queue. Idempotent; run by migrations and again by the worker on start. */
export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.canaryRun, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 });
  await boss.createQueue(QUEUES.advisoriesSync, { retryLimit: 3, retryDelay: 10, retryBackoff: true });
  await boss.createQueue(QUEUES.githubWebhook, { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 5 * 60 });
  await boss.createQueue(QUEUES.webhookSweep, { retryLimit: 1, retryDelay: 60, expireInSeconds: 5 * 60 });
}

/** pg-boss for the database owner: creates its `pgboss` schema and the queues. Used by migrate. */
export async function prepareQueues(databaseUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: databaseUrl, application_name: "shapi-migrate", supervise: false, schedule: false });
  await boss.start();
  try {
    await createQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/** A send-only pg-boss for the web process: no maintenance, no schedules, no schema changes. */
export async function startSender(databaseUrl: string, log: Logger): Promise<{ boss: PgBoss; enqueueWebhook: (deliveryId: string) => Promise<void> }> {
  const boss = new PgBoss({ connectionString: databaseUrl, application_name: "shapi-web", supervise: false, schedule: false, migrate: false, createSchema: false });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();
  return { boss, enqueueWebhook: (deliveryId) => sendWebhook(boss, deliveryId) };
}

async function sendWebhook(boss: PgBoss, deliveryId: string): Promise<void> {
  await boss.send(QUEUES.githubWebhook, { deliveryId }, { singletonKey: deliveryId });
}

export interface WorkerDeps {
  /** Connection string for pg-boss (runs as the owner: it manages its own `pgboss` schema). */
  databaseUrl: string;
  /** App-role database client for job bodies. */
  db: Db;
  config: Pick<Config, "CANARY_CRON" | "SHAPI_ADVISORIES" | "canaryProviders" | "githubApp" | "WEBHOOK_SWEEP_CRON" | "WEBHOOK_RETENTION_DAYS">;
  env: Record<string, string | undefined>;
  log: Logger;
  fetch?: typeof globalThis.fetch;
}

/**
 * Start pg-boss, create the queues, register handlers and the schedules. Jobs are durable
 * (stored in Postgres), retried with backoff, and a scheduled job runs once even with many workers.
 */
export async function startWorker(deps: WorkerDeps): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: deps.databaseUrl, application_name: "shapi-worker" });
  boss.on("error", (err) => deps.log.error({ err }, "pg-boss error"));
  await boss.start();
  await createQueues(boss);

  const app = deps.config.githubApp;
  const github = app ? githubClients({ appId: app.appId, privateKey: app.privateKey }, { fetch: deps.fetch }) : undefined;

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
  await boss.work<{ deliveryId: string }>(QUEUES.githubWebhook, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    if (!github) throw new Error("GitHub App is not configured");
    const result = await processDelivery({ db: deps.db, github }, job.data.deliveryId);
    deps.log.info(result, "webhook processed");
    return result;
  });
  await boss.work(QUEUES.webhookSweep, async () => {
    const result = await sweepWebhooks({
      db: deps.db,
      github,
      enqueue: (deliveryId) => sendWebhook(boss, deliveryId),
      retentionDays: deps.config.WEBHOOK_RETENTION_DAYS,
    });
    deps.log.info(result, "webhooks swept");
    return result;
  });

  if (deps.config.CANARY_CRON) await boss.schedule(QUEUES.canaryRun, deps.config.CANARY_CRON);
  else await boss.unschedule(QUEUES.canaryRun);
  if (deps.config.WEBHOOK_SWEEP_CRON) await boss.schedule(QUEUES.webhookSweep, deps.config.WEBHOOK_SWEEP_CRON);
  else await boss.unschedule(QUEUES.webhookSweep);

  // Reviewed advisories may have changed with this deploy.
  await boss.send(QUEUES.advisoriesSync, {});
  return boss;
}
