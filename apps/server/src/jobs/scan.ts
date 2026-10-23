import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdvisorySchema, ApiLockSchema, createApiLock, matchAdvisories, type ApiLock, type Finding, type MatchResult } from "@shapi/core";
import { withService, type Db, type Tx } from "@shapi/db";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { checkRunOutput, completeCheckRun, fetchRepoSnapshot, startCheckRun } from "@shapi/github-app";
import type { SnapshotFile } from "@shapi/sandbox";
import { repositoryCovered } from "../billing/plan";
import type { Notifier } from "../notify/slack";
import type { GitHubClients } from "../github/clients";

export interface ScanDeps {
  db: Db;
  github: GitHubClients;
  /** Billing is configured: private repositories beyond the plan are not scanned. */
  billingEnforced?: boolean;
  now?: () => Date;
  /** Told about newly affected call sites once the scan is stored (Slack alerts). */
  notify?: Notifier;
}

/** Either a scan queued by a push, or a repository to scan at its default branch head (first scan after install). */
export type ScanJob = { scanId: string } | { repositoryId: string };

export interface ScanReport {
  scanId?: string;
  repositoryId?: string;
  status: "succeeded" | "failed" | "skipped";
  reason?: string;
  callSites?: number;
  affected?: number;
  exposed?: number;
  /** Affected call sites mean a fix job should follow. */
  fix?: boolean;
}

/** Load the advisories the matcher uses (reviewed only) with the version of each, for change tracking. */
export async function reviewedAdvisories(db: Db) {
  const rows = await db.selectFrom("advisories").select(["id", "data", "modified"]).where("reviewed", "=", true).orderBy("id").execute();
  return rows.map((r) => ({ advisory: AdvisorySchema.parse(r.data), modified: r.modified.toISOString() }));
}

/** Static analysis of a snapshot: it reads the code and runs none of it, so it does not need a sandbox. */
export function lockFromSnapshot(files: SnapshotFile[]): ApiLock {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-scan-"));
  try {
    for (const f of files) {
      const abs = path.join(dir, f.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    return createApiLock(extractCallSites(dir), "shapi cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace a scan's findings with this match, and record which advisory versions it was matched against. */
/** One affected call site, independent of line numbers: the same finding survives unrelated edits above it. */
const findingKey = (advisoryId: string, site: { file: string; endpoint: string | null }) => `${advisoryId}|${site.file}|${site.endpoint ?? ""}`;

/**
 * Store a scan's findings and return the affected ones that are new: not affected in the repository's
 * previous successful scan, nor in this scan before (an advisory fan-out re-matches a stored scan).
 */
export async function saveFindings(
  tx: Tx,
  scan: { id: string; account_id: string; repository_id: string },
  match: Pick<MatchResult, "affected" | "exposed">,
  evaluated: Record<string, string>,
): Promise<Finding[]> {
  const previousScan = await tx
    .selectFrom("scans")
    .select("id")
    .where("repository_id", "=", scan.repository_id)
    .where("id", "!=", scan.id)
    .where("status", "=", "succeeded")
    .orderBy("finished_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const before = await tx
    .selectFrom("findings")
    .select(["advisory_id", "call_site"])
    .where("kind", "=", "affected")
    .where("scan_id", "in", previousScan ? [scan.id, previousScan.id] : [scan.id])
    .execute();
  const known = new Set(before.map((f) => findingKey(f.advisory_id, f.call_site as { file: string; endpoint: string | null })));
  const fresh = match.affected.filter((f) => !known.has(findingKey(f.advisory.id, f.callSite)));

  await tx.deleteFrom("findings").where("scan_id", "=", scan.id).execute();
  const rows = [
    ...match.affected.map((f) => ({ kind: "affected" as const, f })),
    ...match.exposed.map((f) => ({ kind: "exposed" as const, f })),
  ].map(({ kind, f }: { kind: "affected" | "exposed"; f: Finding }) => ({
    account_id: scan.account_id,
    repository_id: scan.repository_id,
    scan_id: scan.id,
    advisory_id: f.advisory.id,
    kind,
    call_site: JSON.stringify(f.callSite),
    reasons: JSON.stringify(f.reasons),
  }));
  if (rows.length) await tx.insertInto("findings").values(rows).execute();
  await tx.updateTable("scans").set({ advisories: JSON.stringify(evaluated) }).where("id", "=", scan.id).execute();
  return fresh;
}

/**
 * Scan one commit: download it with a read-only token, map its third-party API call sites into an
 * api.lock, match the reviewed advisories, store the findings, and report them as the SHAPI check
 * on the commit. Code is read, never run.
 */
export async function runScanJob(deps: ScanDeps, job: ScanJob): Promise<ScanReport> {
  const now = deps.now ?? (() => new Date());
  const scanId = "scanId" in job ? job.scanId : await queueHeadScan(deps, job.repositoryId);
  if (!scanId) return { status: "skipped", reason: "repository has no default branch commit, or a scan is already pending" };

  const ctx = await withService(deps.db, async (tx) => {
    const row = await tx
      .selectFrom("scans")
      .innerJoin("repositories", "repositories.id", "scans.repository_id")
      .innerJoin("accounts", "accounts.id", "scans.account_id")
      .select([
        "scans.id",
        "scans.account_id",
        "scans.repository_id",
        "scans.sha",
        "scans.status",
        "repositories.full_name",
        "repositories.github_repo_id",
        "repositories.enabled",
        "accounts.github_installation_id",
        "accounts.suspended_at",
        "accounts.settings",
      ])
      .where("scans.id", "=", scanId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status !== "queued") return { row, claimed: false };
    if (!row.enabled || row.suspended_at || !row.github_installation_id) {
      await tx.updateTable("scans").set({ status: "failed", error: "repository disabled or account suspended", finished_at: now() }).where("id", "=", scanId).execute();
      return { row, claimed: false };
    }
    await tx.updateTable("scans").set({ status: "running", started_at: now() }).where("id", "=", scanId).execute();
    return { row, claimed: true };
  });
  const scan = ctx.row;
  if (!scan || !ctx.claimed) return { scanId, status: "skipped", reason: scan ? `scan is ${scan.status}` : "scan not found" };
  const plan = await repositoryCovered(deps.db, scan.account_id, scan.repository_id, deps.billingEnforced ?? false);
  if (!plan.covered) {
    const reason = `not covered by the plan: ${plan.reason}`;
    await withService(deps.db, (tx) => tx.updateTable("scans").set({ status: "failed", error: reason, finished_at: now() }).where("id", "=", scan.id).execute());
    return { scanId, repositoryId: scan.repository_id, status: "skipped", reason };
  }

  const installation = scan.github_installation_id!;
  const [owner, repo] = scan.full_name.split("/") as [string, string];
  const octokit = deps.github.installation(installation);
  // A missing check run (for example the checks permission was not granted) must not stop the scan.
  const checkRunId = await startCheckRun(octokit, { owner, repo, sha: scan.sha }).catch(() => undefined);

  try {
    const readOnly = await deps.github.readOnly(installation, scan.github_repo_id);
    const files = await fetchRepoSnapshot(readOnly, { owner, repo, ref: scan.sha });
    await loadPythonParser();
    const lock = lockFromSnapshot(files);
    const advisories = await reviewedAdvisories(deps.db);
    const match = matchAdvisories(lock, advisories.map((a) => a.advisory), { now: now() });
    const evaluated = Object.fromEntries(advisories.map((a) => [a.advisory.id, a.modified]));

    const fresh = await withService(deps.db, async (tx) => {
      const fresh = await saveFindings(tx, scan, match, evaluated);
      await tx
        .updateTable("scans")
        .set({ status: "succeeded", api_lock: JSON.stringify(lock), finished_at: now(), error: null, check_run_id: checkRunId ?? null })
        .where("id", "=", scan.id)
        .execute();
      await tx.updateTable("repositories").set({ last_scan_sha: scan.sha, last_scanned_at: now() }).where("id", "=", scan.repository_id).execute();
      return fresh;
    });
    if (fresh.length) await deps.notify?.({ accountId: scan.account_id, repositoryId: scan.repository_id, sha: scan.sha, reason: "push", findings: fresh });
    if (checkRunId) {
      const failOnAffected = (scan.settings as { failOnAffected?: boolean }).failOnAffected === true;
      await completeCheckRun(octokit, { owner, repo, checkRunId }, checkRunOutput(match, { failOnAffected })).catch(() => undefined);
    }
    return { scanId, repositoryId: scan.repository_id, status: "succeeded", callSites: lock.callSites.length, affected: match.affected.length, exposed: match.exposed.length, fix: match.affected.length > 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withService(deps.db, (tx) => tx.updateTable("scans").set({ status: "failed", error: message.slice(0, 2000), finished_at: now() }).where("id", "=", scan.id).execute());
    if (checkRunId) {
      await completeCheckRun(octokit, { owner, repo, checkRunId }, {
        conclusion: "neutral",
        output: { title: "SHAPI could not scan this commit", summary: message.slice(0, 1000), annotations: [] },
      }).catch(() => undefined);
    }
    return { scanId, status: "failed", reason: message };
  }
}

/** Queue a scan of the repository's default branch head, unless one is already pending for it. */
async function queueHeadScan(deps: ScanDeps, repositoryId: string): Promise<string | undefined> {
  const repo = await withService(deps.db, (tx) =>
    tx
      .selectFrom("repositories")
      .innerJoin("accounts", "accounts.id", "repositories.account_id")
      .select(["repositories.id", "repositories.account_id", "repositories.full_name", "repositories.default_branch", "accounts.github_installation_id"])
      .where("repositories.id", "=", repositoryId)
      .executeTakeFirst(),
  );
  if (!repo?.github_installation_id) return undefined;
  const [owner, name] = repo.full_name.split("/") as [string, string];
  let sha: string;
  try {
    sha = (await deps.github.installation(repo.github_installation_id).rest.repos.getBranch({ owner, repo: name, branch: repo.default_branch })).data.commit.sha;
  } catch (err) {
    // An empty repository has no branch yet.
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
  return withService(deps.db, async (tx) => {
    const pending = await tx.selectFrom("scans").select("id").where("repository_id", "=", repo.id).where("sha", "=", sha).where("status", "in", ["queued", "running"]).executeTakeFirst();
    if (pending) return undefined;
    const row = await tx.insertInto("scans").values({ account_id: repo.account_id, repository_id: repo.id, sha, status: "queued" }).returning("id").executeTakeFirstOrThrow();
    return row.id;
  });
}

/** Scans still queued after `minutes`: their job was lost (for example the worker restarted before sending it). */
export async function staleQueuedScans(db: Db, now: Date, minutes = 10): Promise<string[]> {
  const rows = await withService(db, (tx) =>
    tx.selectFrom("scans").select("id").where("status", "=", "queued").where("created_at", "<", new Date(now.getTime() - minutes * 60_000)).orderBy("id").limit(200).execute(),
  );
  return rows.map((r) => r.id);
}

/** A stored api.lock, validated. */
export function storedLock(value: unknown): ApiLock {
  return ApiLockSchema.parse(value);
}
