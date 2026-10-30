import { PgBoss } from "pg-boss";
import type { Db } from "@shapi/db";
import { claudeFixer, type LlmFixer } from "@shapi/repair";
import { sandboxFromEnv } from "@shapi/sandbox";
import { stripeClient, syncAllQuantities, type BillingDeps } from "./billing/stripe";
import type { Config } from "./config";
import { githubClients } from "./github/clients";
import { jobsQueued, processDelivery, type ScanRequest } from "./github/events";
import { syncAdvisoriesFromGitHub, syncAdvisoriesJob } from "./jobs/advisories";
import { runCanaryJob } from "./jobs/canary";
import { settleDeadJob } from "./jobs/dead-letter";
import { runAdvisoryFanout } from "./jobs/fanout";
import { runFixJob, sandboxRunner, scansToRefix, type WorkspaceRunner } from "./jobs/fix";
import { SCAN_JOB_TIMEOUT_MS, runScanJob, staleQueuedScans, stopHungScans } from "./jobs/scan";
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
  /** Every other queue's jobs land here once they fail all their attempts (see the dead-letter worker). */
  deadLetter: "dead-letter",
} as const;

export interface Logger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

type QueueOptions = NonNullable<Parameters<PgBoss["createQueue"]>[1]>;

/**
 * Every queue and its options (execution plan I-02). Each has a time limit (expireInSeconds: pg-boss fails the
 * attempt and aborts its job.signal) and sends a job that fails every attempt to the dead-letter queue.
 */
const WORK_QUEUES: [string, QueueOptions][] = [
  [QUEUES.canaryRun, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 15 * 60 }],
  [QUEUES.advisoriesSync, { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 10 * 60 }],
  [QUEUES.githubWebhook, { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 5 * 60 }],
  [QUEUES.webhookSweep, { retryLimit: 1, retryDelay: 60, expireInSeconds: 5 * 60 }],
  // The scan stops itself at SCAN_JOB_TIMEOUT_MS and fails; the expiry a minute later is the backstop. The heartbeat
  // retries a job whose worker died within about a minute, and the retry takes over the scan (see runScanJob).
  [QUEUES.repoScan, { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: SCAN_JOB_TIMEOUT_MS / 1000 + 60, heartbeatSeconds: 60 }],
  // One fix job running and one waiting per repository (keyed by repository id), so PR deliveries never race.
  // A later one is dropped while one waits; the waiting one fixes the repository's latest scan (see runFixJob).
  // Its expiry is well past the sandbox's hour (MAX_SANDBOX_LIFETIME_MS): pg-boss would otherwise retry a job still running.
  [QUEUES.repoFix, { policy: "stately", retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 75 * 60 }],
  [QUEUES.advisoryFanout, { retryLimit: 2, retryDelay: 60, expireInSeconds: 15 * 60 }],
  [QUEUES.billingSync, { policy: "short", retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 }],
  [QUEUES.fixRetry, { policy: "short", retryLimit: 2, retryDelay: 60, expireInSeconds: 10 * 60 }],
];

/** The dead-letter queue first: the others refer to it. Its jobs are kept 30 days after they are handled. */
export const QUEUE_OPTIONS: [string, QueueOptions][] = [
  [QUEUES.deadLetter, { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 5 * 60, deleteAfterSeconds: 30 * 24 * 3600 }],
  ...WORK_QUEUES.map(([name, options]): [string, QueueOptions] => [name, { ...options, deadLetter: QUEUES.deadLetter }]),
];

/**
 * Create or update every queue. Idempotent; run by migrations and again by the worker on start. pg-boss's
 * createQueue leaves an existing queue as it is, so the options are applied again with updateQueue. A queue's
 * policy cannot change after creation: a different one in the database fails loudly.
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of QUEUE_OPTIONS) {
    await boss.createQueue(name, options);
    const { policy = "standard", ...rest } = options;
    const stored = (await boss.getQueue(name))?.policy;
    if (stored !== policy) throw new Error(`queue ${name} has policy ${stored}, not ${policy}: a policy cannot change, recreate the queue`);
    await boss.updateQueue(name, rest);
  }
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

/**
 * The sweeper's send: skipped while a job for the delivery still waits. The queue's standard policy does
 * not enforce singletonKey, so without this every sweep of a backlog would add another job per delivery.
 */
export async function sendWebhookOnce(boss: PgBoss, deliveryId: string): Promise<void> {
  if ((await boss.findJobs(QUEUES.githubWebhook, { key: deliveryId, queued: true })).length) return;
  await sendWebhook(boss, deliveryId);
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
  > &
    Partial<Pick<Config, "OBSERVATION_RETENTION_DAYS">>;
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
      : { ...(await syncAdvisoriesJob(deps.db, deps.config.SHAPI_ADVISORIES)), invalid: [] };
    if (result.invalid.length) deps.log.error({ err: new Error("invalid advisories skipped"), invalid: result.invalid }, "advisory sync skipped invalid files");
    deps.log.info({ source: repo ?? "folder", written: result.written, removed: result.removed }, "advisories synced");
    // Re-matching only does work when something changed (see upsertAdvisories); a removal changes findings too.
    if (result.written || result.removed.length) await boss.send(QUEUES.advisoryFanout, {});
    return { written: result.written, removed: result.removed.length };
  });
  await boss.work(QUEUES.canaryRun, async () => {
    const result = await runCanaryJob({ db: deps.db, env: deps.env, providers: deps.config.canaryProviders, fetch: deps.fetch, retentionDays: deps.config.OBSERVATION_RETENTION_DAYS });
    deps.log.info(result, "canary run finished");
    return result;
  });
  await boss.work<{ deliveryId: string }>(QUEUES.githubWebhook, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const result = await processDelivery({ db: deps.db, github: requireGithub(), billing }, job.data.deliveryId);
    // Committed: now the scans it asked for can start. They stay stored with the delivery until all are queued.
    for (const scan of result.scans) await sendScan(boss, scan);
    for (const f of result.fixes) await sendFix(boss, f.scanId, f.repositoryId);
    if (result.scans.length || result.fixes.length) await jobsQueued(deps.db, job.data.deliveryId);
    // Repositories came or went: a paid plan may now be larger than needed.
    if (billing && ["installation", "installation_repositories"].includes(result.event)) await boss.send(QUEUES.billingSync, {});
    deps.log.info(result, "webhook processed");
    return result;
  });
  await boss.work<ScanRequest>(QUEUES.repoScan, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const report = await runScanJob({ db: deps.db, github: requireGithub(), billingEnforced, notify, publicUrl: deps.config.SHAPI_PUBLIC_URL }, job.data, {
      signal: job.signal,
      retry: job.retryCount > 0,
    });
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
        publicUrl: deps.config.SHAPI_PUBLIC_URL,
      },
      // The job's id stays the same across its retries: they share its LLM budget.
      { scanId: job.data.scanId, jobId: job.id },
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
    const scans = await scansToRefix(deps.db, deps.config.GIT_SHA, { llm: Boolean(llm), billingEnforced });
    for (const s of scans) await sendScan(boss, { repositoryId: s.repositoryId });
    deps.log.info({ engine: deps.config.GIT_SHA, scans: scans.length }, "repositories scanned again for this build");
    return { scans: scans.length };
  });
  await boss.work(QUEUES.billingSync, async () => {
    if (!billing) return { synced: 0 };
    const result = await syncAllQuantities(billing, deps.log);
    deps.log.info({ accounts: result.synced, changes: result.changes, failed: result.failed }, "billing synced");
    return result;
  });
  await boss.work(QUEUES.deadLetter, { batchSize: 1, includeMetadata: true }, async ([job]) => {
    if (!job) return;
    const result = await settleDeadJob(deps.db, { queue: job.sourceName, id: job.sourceId, retries: job.sourceRetryCount, data: job.data, output: job.sourceOutput }, QUEUES.repoScan);
    // Logged as an error, so Sentry alerts on it.
    deps.log.error({ err: new Error(`${job.sourceName} job failed after ${result.attempts} attempts: ${result.error}`), queue: job.sourceName, jobId: job.sourceId, data: job.data, ...result }, "job dead-lettered");
    return result;
  });
  await boss.work(QUEUES.webhookSweep, async () => {
    // Hung scans are failed first, then lost ones re-queued, so a failing webhook sweep cannot hold them up.
    for (const scan of await stopHungScans(deps.db, new Date())) {
      deps.log.error({ err: new Error(`scan ${scan.id} hung: still running past its time limit`), scanId: scan.id, repositoryId: scan.repository_id }, "hung scan stopped");
    }
    const stale = await staleQueuedScans(deps.db, new Date());
    for (const scanId of stale) await sendScan(boss, { scanId });
    const result = await sweepWebhooks({
      db: deps.db,
      github,
      enqueue: (deliveryId) => sendWebhookOnce(boss, deliveryId),
      retentionDays: deps.config.WEBHOOK_RETENTION_DAYS,
    });
    if (result.redeliveryFailed) deps.log.error({ err: new Error("webhook redelivery failed"), redeliveryFailed: result.redeliveryFailed }, "some webhook redeliveries failed");
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
