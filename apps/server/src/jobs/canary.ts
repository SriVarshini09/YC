import { runOnce, type Env, type RunReport } from "@shapi/canary";
import { PgShapeStore, upsertAdvisories, type Db } from "@shapi/db";
import { sensorChanges } from "../sensor";

export interface CanaryJobOptions {
  db: Db;
  env: Env;
  providers?: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Days of repeated shapes to keep; older repeats are deleted after each run (the newest of each shape stays). */
  retentionDays?: number;
}

export interface CanaryJobResult {
  probes: number;
  changed: number;
  failed: number;
  skipped: number;
  drafts: string[];
  /** Old observations deleted because a newer one has the same shape. */
  pruned: number;
  /** Changes at least 3 accounts' traffic sensors saw (F-01), and how many of them the canary saw too. */
  sensorChanges: number;
  sensorConfirmed: number;
}

/**
 * One canary run: probe every provider with credentials, store shapes in Postgres, and file a
 * draft advisory (unreviewed, hidden from matching) for every breaking change.
 */
export async function runCanaryJob(opts: CanaryJobOptions): Promise<CanaryJobResult> {
  const store = new PgShapeStore(opts.db);
  const report: RunReport = await runOnce({
    store,
    env: opts.env,
    providers: opts.providers,
    fetch: opts.fetch,
    now: opts.now,
  });
  const drafts = report.results.flatMap((r) => (r.draft ? [r.draft] : []));
  if (drafts.length > 0) await upsertAdvisories(opts.db, drafts, { reviewed: false, source: "canary" });
  const now = opts.now?.() ?? new Date();
  const pruned = await store.prune(new Date(now.getTime() - (opts.retentionDays ?? 30) * 86_400_000));
  // Checked after the canary has stored this run's shapes, so a change both saw is confirmed in the same run.
  const sensed = await sensorChanges(opts.db);
  return {
    probes: report.results.length,
    changed: report.results.filter((r) => r.changed).length,
    failed: report.results.filter((r) => r.error).length,
    skipped: report.skipped.length,
    drafts: drafts.map((d) => d.id),
    pruned,
    sensorChanges: sensed.length,
    sensorConfirmed: sensed.filter((c) => c.canary).length,
  };
}
