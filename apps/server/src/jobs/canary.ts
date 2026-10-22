import { runOnce, type Env, type RunReport } from "@shapi/canary";
import { PgShapeStore, upsertAdvisories, type Db } from "@shapi/db";

export interface CanaryJobOptions {
  db: Db;
  env: Env;
  providers?: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface CanaryJobResult {
  probes: number;
  changed: number;
  failed: number;
  skipped: number;
  drafts: string[];
}

/**
 * One canary run: probe every provider with credentials, store shapes in Postgres, and file a
 * draft advisory (unreviewed, hidden from matching) for every breaking change.
 */
export async function runCanaryJob(opts: CanaryJobOptions): Promise<CanaryJobResult> {
  const report: RunReport = await runOnce({
    store: new PgShapeStore(opts.db),
    env: opts.env,
    providers: opts.providers,
    fetch: opts.fetch,
    now: opts.now,
  });
  const drafts = report.results.flatMap((r) => (r.draft ? [r.draft] : []));
  if (drafts.length > 0) await upsertAdvisories(opts.db, drafts, { reviewed: false, source: "canary" });
  return {
    probes: report.results.length,
    changed: report.results.filter((r) => r.changed).length,
    failed: report.results.filter((r) => r.error).length,
    skipped: report.skipped.length,
    drafts: drafts.map((d) => d.id),
  };
}
