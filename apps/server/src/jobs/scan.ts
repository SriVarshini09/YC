import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorySchema, ApiLockSchema, createApiLock, matchAdvisories, type ApiLock, type Finding, type MatchResult } from "@shapi/core";
import { withService, type Db, type Tx } from "@shapi/db";
import { extractCallSites } from "@shapi/extractor";
import { checkRunOutput, completeCheckRun, fetchRepoSnapshot, startCheckRun } from "@shapi/github-app";
import type { SnapshotFile } from "@shapi/sandbox";
import { repositoryCovered } from "../billing/plan";
import type { Notifier } from "../notify/slack";
import type { GitHubClients } from "../github/clients";
import { insertPendingScan } from "../github/events";
import { repoPageUrl } from "../links";
import { reportError } from "../observability";

export interface ScanDeps {
  db: Db;
  github: GitHubClients;
  /** Billing is configured: private repositories beyond the plan are not scanned. */
  billingEnforced?: boolean;
  now?: () => Date;
  /** Told about newly affected call sites once the scan is stored (Slack alerts). */
  notify?: Notifier;
  /** The web app's public URL: each check run links to the repository's page there. */
  publicUrl?: string;
  /** Overrides of DEFAULT_SCAN_LIMITS (tests). */
  scanLimits?: Partial<ScanLimits>;
}

/** Either a scan queued by a push, or a repository to scan at its default branch head (first scan after install). */
export type ScanJob = { scanId: string } | { repositoryId: string };

/** How this attempt of the job runs (execution plan I-02). */
export interface ScanRun {
  /** The queue's signal: aborted when the worker shuts down or loses the job. The scan goes back to queued. */
  signal?: AbortSignal;
  /** A retried job, whose earlier attempt died with its worker: it may take over the scan that attempt left running. */
  retry?: boolean;
  /** How long the scan may take before SHAPI stops it and marks it failed. Default SCAN_JOB_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** A scan job's time limit; the repo-scan queue expires a job a minute later, as a backstop (see QUEUE_OPTIONS). */
export const SCAN_JOB_TIMEOUT_MS = 14 * 60_000;
/** A scan still running this long after it started is hung: the sweep marks it failed (see stopHungScans). */
export const SCAN_HUNG_MINUTES = 20;

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
  const dir = writeSnapshot(files);
  try {
    return createApiLock(extractCallSites(dir), "shapi cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSnapshot(files: SnapshotFile[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-scan-"));
  try {
    for (const f of files) {
      const abs = path.join(dir, "repo", f.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return path.join(dir, "repo");
}

/** How much one scan may use (execution plan I-01). */
export interface ScanLimits {
  /** The scan process's V8 heap limit. */
  heapMb: number;
  timeoutMs: number;
  /** TypeScript, JavaScript and Python source above this is not scanned: it would not fit in `heapMb`. */
  maxSourceBytes: number;
}

/**
 * Sized for a 1 GB worker. A scan needs roughly 150 bytes of heap per byte of source (APIBreak-Replay's
 * Nori: 2.1 MB of source, 304 MB peak), so 640 MB of heap fits about 4 MB of source.
 */
export const DEFAULT_SCAN_LIMITS: ScanLimits = { heapMb: 640, timeoutMs: 10 * 60_000, maxSourceBytes: 4 * 1024 * 1024 };

/** A repository SHAPI cannot scan within its limits. Reported to the user as is, and to Sentry. */
export class ScanTooLargeError extends Error {
  override name = "ScanTooLargeError";
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/i;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The scan process's entry point: bin/scan-child.mjs, next to dist/ in the image and above src/ in the repository. */
function scanChild(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    const candidate = path.join(dir, "bin", "scan-child.mjs");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("bin/scan-child.mjs not found");
}

/**
 * Scan a snapshot in its own process with a memory cap and a time limit, so a repository too large for memory
 * fails alone (with ScanTooLargeError) instead of crashing the worker and every job it runs.
 */
export async function lockInProcess(files: SnapshotFile[], limits: Partial<ScanLimits> = {}, signal?: AbortSignal): Promise<ApiLock> {
  signal?.throwIfAborted();
  const { heapMb, timeoutMs, maxSourceBytes } = { ...DEFAULT_SCAN_LIMITS, ...limits };
  const sourceBytes = files.filter((f) => SOURCE_FILE.test(f.path)).reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (sourceBytes > maxSourceBytes) {
    throw new ScanTooLargeError(`this repository has ${mb(sourceBytes)} of TypeScript, JavaScript and Python source; SHAPI scans up to ${mb(maxSourceBytes)} for now`);
  }
  const dir = writeSnapshot(files);
  const out = path.join(path.dirname(dir), "api.lock.json");
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, scanChild(), dir, out], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      let timedOut = false;
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-8000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      // The job was stopped: so is its scan process.
      const stop = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", stop, { once: true });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        reject(err);
      });
      child.on("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve({ code, signal: exitSignal, stderr, timedOut });
      });
    });
    signal?.throwIfAborted();
    if (result.timedOut) throw new ScanTooLargeError(`the scan took longer than ${Math.round(timeoutMs / 60_000)} minutes`);
    if (/heap out of memory|Allocation failed/i.test(result.stderr)) {
      throw new ScanTooLargeError(`scanning this repository needed more than ${heapMb} MB of memory (${mb(sourceBytes)} of source)`);
    }
    if (result.code !== 0) {
      const last = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${result.code ?? result.signal}`;
      throw new Error(`the scan process failed: ${last.slice(0, 300)}`);
    }
    return ApiLockSchema.parse(JSON.parse(readFileSync(out, "utf8")));
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
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
export async function runScanJob(deps: ScanDeps, job: ScanJob, run: ScanRun = {}): Promise<ScanReport> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = run.timeoutMs ?? SCAN_JOB_TIMEOUT_MS;
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
    // A retry may take over a running scan: its earlier attempt died with its worker (the queue's heartbeat
    // noticed), so nothing else is running it.
    if (!row || !(row.status === "queued" || (run.retry && row.status === "running"))) return { row, claimed: false };
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
  const checkRunId = await startCheckRun(octokit, { owner, repo, sha: scan.sha, detailsUrl: repoPageUrl(deps.publicUrl, scan.account_id, scan.repository_id) }).catch(() => undefined);

  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = run.signal ? AbortSignal.any([run.signal, deadline]) : deadline;
  try {
    const readOnly = await deps.github.readOnly(installation, scan.github_repo_id);
    const files = await fetchRepoSnapshot(readOnly, { owner, repo, ref: scan.sha }, undefined, signal);
    const lock = await lockInProcess(files, deps.scanLimits, signal);
    signal.throwIfAborted();
    const advisories = await reviewedAdvisories(deps.db);
    const match = matchAdvisories(lock, advisories.map((a) => a.advisory), { now: now() });
    const evaluated = Object.fromEntries(advisories.map((a) => [a.advisory.id, a.modified]));

    const { fresh, accountId } = await withService(deps.db, async (tx) => {
      // The repository may have moved to another account since the scan was claimed (a transfer moves its history):
      // its findings go to the account it is in now. Locked, so a transfer waits for this write and then moves them too.
      const current = await tx.selectFrom("repositories").select("account_id").where("id", "=", scan.repository_id).forUpdate().executeTakeFirst();
      const accountId = current?.account_id ?? scan.account_id;
      const fresh = await saveFindings(tx, { ...scan, account_id: accountId }, match, evaluated);
      await tx
        .updateTable("scans")
        .set({ status: "succeeded", account_id: accountId, api_lock: JSON.stringify(lock), finished_at: now(), error: null, check_run_id: checkRunId ?? null })
        .where("id", "=", scan.id)
        .execute();
      await tx.updateTable("repositories").set({ last_scan_sha: scan.sha, last_scanned_at: now() }).where("id", "=", scan.repository_id).execute();
      return { fresh, accountId };
    });
    if (fresh.length) await deps.notify?.({ accountId, repositoryId: scan.repository_id, sha: scan.sha, reason: "push", findings: fresh });
    if (checkRunId) {
      const failOnAffected = (scan.settings as { failOnAffected?: boolean }).failOnAffected === true;
      await completeCheckRun(octokit, { owner, repo, checkRunId }, checkRunOutput(match, { failOnAffected })).catch(() => undefined);
    }
    return { scanId, repositoryId: scan.repository_id, status: "succeeded", callSites: lock.callSites.length, affected: match.affected.length, exposed: match.exposed.length, fix: match.affected.length > 0 };
  } catch (caught) {
    // The worker is shutting down or lost the job: the scan goes back to queued for the job's retry, or the sweep.
    if (run.signal?.aborted && !deadline.aborted) {
      await withService(deps.db, (tx) => tx.updateTable("scans").set({ status: "queued" }).where("id", "=", scan.id).where("status", "=", "running").execute());
      throw caught;
    }
    // Past its time limit (a download or a step that hung): stopped and failed, so the dashboard and the check say so.
    const err = deadline.aborted ? new ScanTooLargeError(`SHAPI stopped this scan after ${duration(timeoutMs)}: it took too long`) : caught;
    const message = err instanceof Error ? err.message : String(err);
    // Too large for SHAPI's limits: the user sees why, and Sentry tells the team.
    if (err instanceof ScanTooLargeError) reportError(err);
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
    const row = await insertPendingScan(tx, { account_id: repo.account_id, repository_id: repo.id, sha });
    return row?.id;
  });
}

/** Scans whose job was lost: still queued after `minutes` (for example the worker restarted before sending it). */
export async function staleQueuedScans(db: Db, now: Date, minutes = 10): Promise<string[]> {
  const rows = await withService(db, (tx) =>
    tx.selectFrom("scans").select("id").where("status", "=", "queued").where("created_at", "<", new Date(now.getTime() - minutes * 60_000)).orderBy("id").limit(200).execute(),
  );
  return rows.map((r) => r.id);
}

/**
 * Scans still running `minutes` after they started, past the scan job's time limit and its queue's expiry:
 * whatever runs them is hung. They are marked failed, so the dashboard shows it on the next sweep, and not
 * queued again, so a scan that hangs cannot loop. Returns the scans it stopped.
 */
export async function stopHungScans(db: Db, now: Date, minutes = SCAN_HUNG_MINUTES): Promise<{ id: string; repository_id: string }[]> {
  return withService(db, (tx) =>
    tx
      .updateTable("scans")
      .set({ status: "failed", error: `SHAPI stopped this scan: it was still running after ${minutes} minutes`, finished_at: now })
      .where("status", "=", "running")
      .where("started_at", "<", new Date(now.getTime() - minutes * 60_000))
      .returning(["id", "repository_id"])
      .execute(),
  );
}

const duration = (ms: number) => {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.round(ms / 1000), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};

/** A stored api.lock, validated. */
export function storedLock(value: unknown): ApiLock {
  return ApiLockSchema.parse(value);
}
