import { matchAdvisories } from "@shapi/core";
import { withService, type Db } from "@shapi/db";
import type { Notifier } from "../notify/slack";
import { reviewedAdvisories, saveFindings, storedLock } from "./scan";

export interface FanoutReport {
  repositories: number;
  rematched: number;
  /** Scans whose re-match found call sites affected by a new or changed advisory: each needs a fix job. */
  fixScans: { scanId: string; repositoryId: string }[];
}

/**
 * When the advisory database changes, re-match every repository's latest api.lock against it:
 * no code is downloaded again. Only repositories whose last scan has not seen the current version of
 * every advisory are touched, and a fix job is due only where a new or changed advisory hits.
 */
export async function runAdvisoryFanout(db: Db, opts: { now?: Date; notify?: Notifier } = {}): Promise<FanoutReport> {
  const advisories = await reviewedAdvisories(db);
  const current = Object.fromEntries(advisories.map((a) => [a.advisory.id, a.modified]));
  const latest = await withService(db, (tx) =>
    tx
      .selectFrom("scans")
      .innerJoin("repositories", "repositories.id", "scans.repository_id")
      .innerJoin("accounts", "accounts.id", "scans.account_id")
      .select(["scans.id", "scans.account_id", "scans.repository_id", "scans.sha", "scans.api_lock", "scans.advisories"])
      .distinctOn("scans.repository_id")
      .where("scans.status", "=", "succeeded")
      .where("scans.api_lock", "is not", null)
      .where("repositories.enabled", "=", true)
      .where("accounts.suspended_at", "is", null)
      .orderBy("scans.repository_id")
      .orderBy("scans.created_at", "desc")
      .execute(),
  );

  const report: FanoutReport = { repositories: latest.length, rematched: 0, fixScans: [] };
  for (const scan of latest) {
    const seen = scan.advisories ?? {};
    const changed = new Set(Object.keys(current).filter((id) => seen[id] !== current[id]));
    const removed = Object.keys(seen).some((id) => !(id in current));
    if (!changed.size && !removed) continue;
    const match = matchAdvisories(storedLock(scan.api_lock), advisories.map((a) => a.advisory), { now: opts.now });
    const fresh = await withService(db, (tx) => saveFindings(tx, scan, match, current));
    report.rematched++;
    if (fresh.length) await opts.notify?.({ accountId: scan.account_id, repositoryId: scan.repository_id, sha: scan.sha, reason: "advisory", findings: fresh });
    if (match.affected.some((f) => changed.has(f.advisory.id))) report.fixScans.push({ scanId: scan.id, repositoryId: scan.repository_id });
  }
  return report;
}
