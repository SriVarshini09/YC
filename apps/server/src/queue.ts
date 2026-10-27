import { PgBoss } from "pg-boss";
import type { Db } from "@shapi/db";
import { claudeFixer, type LlmFixer } from "@shapi/repair";
import { sandboxFromEnv } from "@shapi/sandbox";
import { withService } from "@shapi/db";
import { stripeClient, syncQuantity, type BillingDeps } from "./billing/stripe";
import type { Config } from "./config";
import { githubClients } from "./github/clients";
import { processDelivery, type ScanRequest } from "./github/events";
import { syncAdvisoriesFromGitHub, syncAdvisoriesJob } from "./jobs/advisories";
import { runCanaryJob } from "./jobs/canary";
import { runAdvisoryFanout } from "./jobs/fanout";
import { runFixJob, sandboxRunner, scansToRefix, type WorkspaceRunner } from "./jobs/fix";
import { runScanJob, staleQueuedScans } from "./jobs/scan";
import { slackNotifier } from "./notify/slack";
import { sweepWebhooks } from "./jobs/webhook-sweeper";

/** Every queue the worker handles. Names are stable: they live in the database. */
export const QUEUES = {
  canaryRun: "canary-run",
  advisoriesSync: "advisories-sync",
  githubWebhook: "github-webhook",
  webhookSweep: "webhook-sweep",
  repoScan: "repo-scan",
  repoFix: "repo-fix",
  advisoryFanout: "advisory-fanout",
  billingSync: "billing-sync",
  fixRetry: "fix-retry",
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
  await boss.createQueue(QUEUES.repoScan, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 });
  // One fix job running and one waiting per repository (keyed by repository id), so PR deliveries never race.
  await boss.createQueue(QUEUES.repoFix, { policy: "stately", retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 30 * 60 });
  await boss.createQueue(QUEUES.advisoryFanout, { retryLimit: 2, retryDelay: 60, expireInSeconds: 15 * 60 });
  await boss.createQueue(QUEUES.billingSync, { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 });
  await boss.createQueue(QUEUES.fixRetry, { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 10 * 60 });
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
export async function startSender(
  databaseUrl: string,
  log: Logger,
): Promise<{ boss: PgBoss; enqueueWebhook: (deliveryId: string) => Promise<void>; enqueueFix: (scanId: string, repositoryId: string) => Promise<void> }> {
  const boss = new PgBoss({ connectionString: databaseUrl, application_name: "shapi-web", supervise: false, schedule: false, migrate: false, createSchema: false });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();
  return { boss, enqueueWebhook: (deliveryId) => sendWebhook(boss, deliveryId), enqueueFix: async (scanId, repositoryId) => void (await sendFix(boss, scanId, repositoryId)) };
}

async function sendWebhook(boss: PgBoss, deliveryId: string): Promise<void> {
  await boss.send(QUEUES.githubWebhook, { deliveryId }, { singletonKey: deliveryId });
}

const sendScan = (boss: PgBoss, scan: ScanRequest) => boss.send(QUEUES.repoScan, scan);
const sendFix = (boss: PgBoss, scanId: string, repositoryId: string) => boss.send(QUEUES.repoFix, { scanId }, { singletonKey: repositoryId });

export interface WorkerDeps {
  /** Connection string for pg-boss (runs as the owner: it manages its own `pgboss` schema). */
  databaseUrl: string;
  /** App-role database client for job bodies. */
  db: Db;
  config: Pick<
    Config,
    | "CANARY_CRON"
    | "SHAPI_ADVISORIES"
    | "SHAPI_ADVISORIES_REPO"
    | "ADVISORIES_SYNC_CRON"
    | "canaryProviders"
    | "githubApp"
    | "WEBHOOK_SWEEP_CRON"
    | "WEBHOOK_RETENTION_DAYS"
    | "SHAPI_RECORDINGS"
    | "FANOUT_CRON"
    | "billing"
    | "SHAPI_PUBLIC_URL"
    | "GIT_SHA"
  >;
  env: Record<string, string | undefined>;
  log: Logger;
  fetch?: typeof globalThis.fetch;
  /** Where fixes are verified; default: the sandbox from the environment (E2B in production). */
  workspace?: WorkspaceRunner;
  /** GitHub client options (tests turn throttling off). */
  githubOptions?: { resilient?: boolean };
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
  const github = app ? githubClients({ appId: app.appId, privateKey: app.privateKey }, { fetch: deps.fetch, ...deps.githubOptions }) : undefined;
  const requireGithub = () => {
    if (!github) throw new Error("GitHub App is not configured");
    return github;
  };
  // Resolved on first use, so a worker without a sandbox still runs everything else.
  let workspace = deps.workspace;
  const requireWorkspace = () => (workspace ??= sandboxRunner(sandboxFromEnv(deps.env)));
  const llm: LlmFixer | undefined = deps.env.ANTHROPIC_API_KEY ? claudeFixer() : undefined;
  const billing: BillingDeps | undefined = deps.config.billing
    ? { db: deps.db, stripe: stripeClient(deps.config.billing, { fetch: deps.fetch }), config: deps.config.billing }
    : undefined;
  const billingEnforced = Boolean(billing);
  const notify = slackNotifier({ db: deps.db, fetch: deps.fetch, publicUrl: deps.config.SHAPI_PUBLIC_URL, advisoriesRepo: deps.config.SHAPI_ADVISORIES_REPO, log: deps.log });

  await boss.work(QUEUES.advisoriesSync, async () => {
    const repo = deps.config.SHAPI_ADVISORIES_REPO;
    const result = repo
      ? await syncAdvisoriesFromGitHub(deps.db, repo, { fetch: deps.fetch })
      : { written: await syncAdvisoriesJob(deps.db, deps.config.SHAPI_ADVISORIES), removed: [], invalid: [] };
    if (result.invalid.length) deps.log.error({ err: new Error("invalid advisories skipped"), invalid: result.invalid }, "advisory sync skipped invalid files");
    deps.log.info({ source: repo ?? "folder", written: result.written, removed: result.removed }, "advisories synced");
    // Re-matching only does work when something changed (see upsertAdvisories); a removal changes findings too.
    if (result.written || result.removed.length) await boss.send(QUEUES.advisoryFanout, {});
    return { written: result.written, removed: result.removed.length };
  });
  await boss.work(QUEUES.canaryRun, async () => {
    const result = await runCanaryJob({ db: deps.db, env: deps.env, providers: deps.config.canaryProviders, fetch: deps.fetch });
    deps.log.info(result, "canary run finished");
    return result;
  });
  await boss.work<{ deliveryId: string }>(QUEUES.githubWebhook, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const result = await processDelivery({ db: deps.db, github: requireGithub() }, job.data.deliveryId);
    // Committed: now the scans it asked for can start.
    for (const scan of result.scans) await sendScan(boss, scan);
    for (const f of result.fixes) await sendFix(boss, f.scanId, f.repositoryId);
    // Repositories came or went: a paid plan may now be larger than needed.
    if (billing && ["installation", "installation_repositories"].includes(result.event)) await boss.send(QUEUES.billingSync, {});
    deps.log.info(result, "webhook processed");
    return result;
  });
  await boss.work<ScanRequest>(QUEUES.repoScan, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const report = await runScanJob({ db: deps.db, github: requireGithub(), billingEnforced, notify }, job.data);
    if (report.fix && report.scanId && report.repositoryId) await sendFix(boss, report.scanId, report.repositoryId);
    deps.log.info(report, "scan finished");
    return report;
  });
  await boss.work<{ scanId: string }>(QUEUES.repoFix, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const report = await runFixJob(
      {
        db: deps.db,
        github: requireGithub(),
        workspace: requireWorkspace(),
        recordingsDir: deps.config.SHAPI_RECORDINGS,
        shapeSecret: deps.env.SHAPI_SHAPE_SECRET ?? "shapi-dev-secret",
        llm,
        billingEnforced,
        engine: deps.config.GIT_SHA,
      },
      job.data,
    );
    deps.log.info({ scanId: report.scanId, repairs: report.repairs, prs: report.delivery?.outcomes }, "fix job finished");
    return report;
  });
  await boss.work(QUEUES.advisoryFanout, async () => {
    const report = await runAdvisoryFanout(deps.db, { notify });
    for (const f of report.fixScans) await sendFix(boss, f.scanId, f.repositoryId);
    deps.log.info(report, "advisory fan-out finished");
    return report;
  });
  await boss.work(QUEUES.fixRetry, async () => {
    // A fresh scan, not a fix job on the old one: the old api.lock was mapped by the old build's extractor and
    // can miss what the code reads, which the contract test needs. The scan queues the fix job as usual.
    const scans = await scansToRefix(deps.db, deps.config.GIT_SHA, { llm: Boolean(llm) });
    for (const s of scans) await sendScan(boss, { repositoryId: s.repositoryId });
    deps.log.info({ engine: deps.config.GIT_SHA, scans: scans.length }, "repositories scanned again for this build");
    return { scans: scans.length };
  });
  await boss.work(QUEUES.billingSync, async () => {
    if (!billing) return { synced: 0 };
    const accounts = await withService(deps.db, (tx) => tx.selectFrom("billing").select("account_id").where("stripe_subscription_id", "is not", null).where("status", "!=", "canceled").execute());
    const changes = [];
    for (const a of accounts) {
      const change = await syncQuantity(billing, a.account_id);
      if (change) changes.push({ accountId: a.account_id, ...change });
    }
    deps.log.info({ accounts: accounts.length, changes }, "billing synced");
    return { synced: accounts.length, changes };
  });
  await boss.work(QUEUES.webhookSweep, async () => {
    const result = await sweepWebhooks({
      db: deps.db,
      github,
      enqueue: (deliveryId) => sendWebhook(boss, deliveryId),
      retentionDays: deps.config.WEBHOOK_RETENTION_DAYS,
    });
    const stale = await staleQueuedScans(deps.db, new Date());
    for (const scanId of stale) await sendScan(boss, { scanId });
    deps.log.info({ ...result, scansRequeued: stale.length }, "webhooks swept");
    return result;
  });

  const schedules: [string, string][] = [
    [QUEUES.canaryRun, deps.config.CANARY_CRON],
    [QUEUES.webhookSweep, deps.config.WEBHOOK_SWEEP_CRON],
    [QUEUES.advisoryFanout, deps.config.FANOUT_CRON],
    [QUEUES.billingSync, billing ? "23 4 * * *" : ""],
    [QUEUES.advisoriesSync, deps.config.SHAPI_ADVISORIES_REPO ? deps.config.ADVISORIES_SYNC_CRON : ""],
  ];
  for (const [queue, cron] of schedules) {
    if (cron) await boss.schedule(queue, cron);
    else await boss.unschedule(queue);
  }

  // Reviewed advisories may have changed with this deploy, and this build may fix what an older one could not.
  await boss.send(QUEUES.advisoriesSync, {});
  if (github) await boss.send(QUEUES.fixRetry, {});
  return boss;
}
