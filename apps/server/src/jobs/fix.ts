import { matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { sql } from "kysely";
import { withService, type Db } from "@shapi/db";
import { fetchRepoSnapshot, prTitle, renderPrBody } from "@shapi/github-app";
import { RECIPES, repairAdvisory, withCallBudget, withSandboxWorkspace, type InstallReport, type AdvisoryRepair, type LlmFixer, type RepairResult, type Workspace } from "@shapi/repair";
import { SandboxLifetimeError, type SandboxProvider, type SnapshotFile } from "@shapi/sandbox";
import type { GitHubClients } from "../github/clients";
import { repositoryCovered } from "../billing/plan";
import { latestScanId } from "../github/events";
import { deliverRepoFixes, type DeliveryReport, type FixCandidate } from "../github/fixes";
import { reviewedAdvisories, storedLock } from "./scan";
import type { ResponseShape } from "@shapi/shapes";
import { shapesFor } from "./shapes";
import { summarizeRepair } from "./repair-summary";

/** Run `fn` in a workspace holding `files`. Production: a fresh E2B sandbox per job. */
export type WorkspaceRunner = <T>(files: SnapshotFile[], labels: Record<string, string>, fn: (ws: Workspace & { install?: InstallReport }) => Promise<T>) => Promise<T>;

export function sandboxRunner(provider: SandboxProvider): WorkspaceRunner {
  return (files, labels, fn) => withSandboxWorkspace(provider, files, fn, { labels });
}

export interface FixDeps {
  db: Db;
  github: GitHubClients;
  workspace: WorkspaceRunner;
  recordingsDir: string;
  shapeSecret: string;
  /** Only used for accounts that turned on LLM fixes: it sends the affected file to the model provider. */
  llm?: LlmFixer;
  /** Billing is configured: private repositories beyond the plan get no fixes. */
  billingEnforced?: boolean;
  /** This SHAPI build (git sha), recorded on the scan once its fix job finishes (see scansToRefix). */
  engine?: string;
  now?: () => Date;
}

export interface FixReport {
  scanId: string;
  skipped?: string;
  /** One entry per advisory; `sites` counts its call sites fixed out of those affected. */
  repairs: { advisoryId: string; status: RepairResult["status"] | "no-shapes" | "no-fix" | "not-attempted"; reason?: string; sites?: { fixed: number; total: number } }[];
  delivery?: DeliveryReport;
}

/**
 * For one scan's affected call sites: repair each fixable advisory test-first inside one sandbox
 * (dependencies installed with only the npm registry reachable, then no network), every affected call
 * site of an advisory into one change, and hand the verified fixes to the PR engine: one PR per
 * advisory. Call sites SHAPI cannot fix go on the dashboard as manual fixes.
 *
 * The job fixes its repository's latest successful scan, which may be newer than the scan it names: the
 * queue keeps one waiting fix job per repository and drops later ones, whose scans would otherwise go unfixed.
 *
 * `jobId` is the pg-boss job's id, which its retries keep: the LLM budget is counted on it, so a retried
 * (or expired) job cannot spend it again, and every new job (a push, a dashboard tick, the fan-out) has its own.
 */
export async function runFixJob(deps: FixDeps, job: { scanId: string; jobId?: string }): Promise<FixReport> {
  const now = deps.now ?? (() => new Date());
  const ctx = await withService(deps.db, async (tx) => {
    const named = await tx.selectFrom("scans").select("repository_id").where("id", "=", job.scanId).executeTakeFirst();
    const scanId = (named && (await latestScanId(tx, named.repository_id))) ?? job.scanId;
    const scan = await tx
      .selectFrom("scans")
      .innerJoin("repositories", "repositories.id", "scans.repository_id")
      .innerJoin("accounts", "accounts.id", "scans.account_id")
      .select([
        "scans.id",
        "scans.sha",
        "scans.status",
        "scans.api_lock",
        "scans.repository_id",
        "scans.account_id",
        "repositories.full_name",
        "repositories.github_repo_id",
        "accounts.github_installation_id",
        "accounts.settings",
      ])
      .where("scans.id", "=", scanId)
      .executeTakeFirst();
    const findings = scan ? await tx.selectFrom("findings").selectAll().where("scan_id", "=", scan.id).where("kind", "=", "affected").orderBy("id").execute() : [];
    return { scan, findings };
  });
  const { scan } = ctx;
  if (!scan || scan.status !== "succeeded" || !scan.api_lock || !scan.github_installation_id) return { scanId: job.scanId, repairs: [] };
  const plan = await repositoryCovered(deps.db, scan.account_id, scan.repository_id, deps.billingEnforced ?? false);
  if (!plan.covered) {
    await markEngine(deps, scan.id);
    return { scanId: scan.id, repairs: [], skipped: `not covered by the plan: ${plan.reason}` };
  }

  const advisories = new Map((await reviewedAdvisories(deps.db)).map((a) => [a.advisory.id, a.advisory]));
  const lock = storedLock(scan.api_lock);
  const { upcoming } = matchAdvisories(lock, [...advisories.values()], { now: now() });

  // Every affected call site, grouped by advisory: one repair (and one PR) per advisory.
  const byAdvisory = new Map<string, { advisory: Advisory; callSites: LockedCallSite[] }>();
  for (const f of ctx.findings) {
    const advisory = advisories.get(f.advisory_id);
    if (!advisory) continue;
    const entry = byAdvisory.get(advisory.id) ?? { advisory, callSites: [] };
    entry.callSites.push(f.call_site as LockedCallSite);
    byAdvisory.set(advisory.id, entry);
  }

  // One budget per job, kept in the database under its id when it has one: a retry shares it. Without an id, counted in memory.
  const jobId = job.jobId;
  const llm =
    (scan.settings as { llmFixes?: boolean }).llmFixes === true && deps.llm ? withCallBudget(deps.llm, undefined, jobId ? () => takeLlmCall(deps.db, jobId) : undefined) : undefined;
  const report: FixReport = { scanId: scan.id, repairs: [] };
  const manual: { advisory: Advisory; callSites: number }[] = [];
  const todo: { advisory: Advisory; callSites: LockedCallSite[]; shapes: { before?: ResponseShape; after?: ResponseShape; source: string } }[] = [];
  for (const entry of byAdvisory.values()) {
    const fixable = (entry.advisory.recipeId && RECIPES[entry.advisory.recipeId]) || llm;
    if (!fixable) {
      report.repairs.push({ advisoryId: entry.advisory.id, status: "no-fix", reason: "no recipe for this change" });
      manual.push({ advisory: entry.advisory, callSites: entry.callSites.length });
      continue;
    }
    // With an advisory fix the contract test is built from the fix itself; otherwise it needs recorded responses.
    const shapes = entry.advisory.fix
      ? { source: "built from the advisory's fix and the fields the code reads" }
      : await shapesFor(deps.db, entry.advisory, deps.recordingsDir, deps.shapeSecret);
    if (!shapes) {
      report.repairs.push({ advisoryId: entry.advisory.id, status: "no-shapes", reason: "no before/after responses recorded for this endpoint" });
      manual.push({ advisory: entry.advisory, callSites: entry.callSites.length });
      continue;
    }
    todo.push({ ...entry, shapes });
  }

  const fixes: FixCandidate[] = [];
  let outOfTime = false;
  if (todo.length) {
    const [owner, repo] = scan.full_name.split("/") as [string, string];
    const readOnly = await deps.github.readOnly(scan.github_installation_id, scan.github_repo_id);
    const files = await fetchRepoSnapshot(readOnly, { owner, repo, ref: scan.sha });
    const snapshot = new Map(files.map((f) => [f.path, f.content]));
    await deps.workspace(files, { scan: scan.id, repository: scan.full_name }, async (ws) => {
      for (const [i, t] of todo.entries()) {
        let repair: AdvisoryRepair | undefined;
        let outOfTimeError: SandboxLifetimeError | undefined;
        try {
          repair = await repairAdvisory({ workspace: ws, advisory: t.advisory, callSites: t.callSites, before: t.shapes.before, after: t.shapes.after, recipes: RECIPES, llm });
          // Leave the workspace as it was, so the next advisory is verified against the original code:
          // changed files get their text back, and files the repair created (contract tests, new modules) are deleted.
          const touched = new Set([...repair.changes, ...repair.sites.flatMap((s) => s.result.changes)].map((c) => c.file));
          for (const s of repair.sites) if (s.result.test) touched.add(s.result.test.file);
          for (const file of touched) {
            const original = snapshot.get(file);
            await (original === undefined ? ws.remove(file) : ws.write(file, String(original)));
          }
        } catch (err) {
          if (!(err instanceof SandboxLifetimeError)) throw err;
          outOfTimeError = err;
        }
        if (repair) {
          const fixedSites = repair.sites.filter((s) => s.result.status === "fixed");
          const unfixed = repair.sites.filter((s) => s.result.status !== "fixed" && s.result.status !== "already-handled");
          const first = unfixed[0]?.result ?? repair.sites[0]?.result;
          report.repairs.push({
            advisoryId: t.advisory.id,
            status: fixedSites.length ? "fixed" : (first?.status ?? "unsupported"),
            ...(fixedSites.length && !unfixed.length ? {} : { reason: first?.reason }),
            sites: { fixed: fixedSites.length, total: repair.sites.length },
          });
          if (unfixed.length) manual.push({ advisory: t.advisory, callSites: unfixed.length });
          if (fixedSites.length) {
            const testFiles = fixedSites.map((s) => s.result.test?.file).join(", ");
            fixes.push({
              advisory: t.advisory,
              title: prTitle(t.advisory),
              body: renderPrBody({ advisory: t.advisory, repair, shapeSource: t.shapes.source }),
              commitMessage: `fix: ${t.advisory.title}\n\nAdvisory ${t.advisory.id}, ${fixedSites.length} of ${repair.sites.length} call sites. Contract tests ${testFiles} fail before this change and pass after, verified in ${repair.sandbox}.`,
              files: repair.changes.map((c) => ({ path: c.file, content: c.after })),
              sha: scan.sha,
              repair: summarizeRepair({ advisory: t.advisory, sites: repair.sites, changes: repair.changes, method: repair.method, sandbox: repair.sandbox }, now()),
            });
          }
        }
        if (outOfTimeError) {
          // The sandbox is out of time. The fixes verified so far are still delivered; the rest are left for the next
          // scan, or the next build (the scan's engine is not marked, see scansToRefix).
          for (const rest of todo.slice(repair ? i + 1 : i)) report.repairs.push({ advisoryId: rest.advisory.id, status: "not-attempted", reason: outOfTimeError.message });
          outOfTime = true;
          break;
        }
      }
    });
  }

  report.delivery = await deliverRepoFixes(deps, {
    repositoryId: scan.repository_id,
    fixes,
    manual,
    upcoming: upcoming.map((u) => ({ advisory: u.advisory, daysUntil: u.daysUntil })),
    now: now(),
  });
  // Only a finished run counts: a failed one throws above, and the job (or the next build) tries again.
  if (!outOfTime) await markEngine(deps, scan.id);
  return report;
}

/**
 * Count one LLM call for a fix job; returns the count so far, this call included. Counts older than two days
 * (far beyond a job's retries and expiry, see QUEUE_OPTIONS) are dropped.
 */
async function takeLlmCall(db: Db, jobId: string): Promise<number> {
  const row = await withService(db, async (tx) => {
    await tx.deleteFrom("fix_job_llm_calls").where("created_at", "<", sql<Date>`now() - interval '2 days'`).execute();
    return tx
      .insertInto("fix_job_llm_calls")
      .values({ job_id: jobId, calls: 1 })
      .onConflict((oc) => oc.column("job_id").doUpdateSet({ calls: sql`fix_job_llm_calls.calls + 1` }))
      .returning("calls")
      .executeTakeFirstOrThrow();
  });
  return row.calls;
}

async function markEngine(deps: Pick<FixDeps, "db" | "engine">, scanId: string): Promise<void> {
  const engine = deps.engine;
  if (engine) await withService(deps.db, (tx) => tx.updateTable("scans").set({ fix_engine: engine }).where("id", "=", scanId).execute());
}

/**
 * Scans whose fixes this build should try again (the worker scans their repository afresh, which queues the
 * fix job): each enabled repository's latest successful scan
 * whose fix job ran on another build (or never ran), with an affected call site that has no fix PR yet
 * and that this build may fix (a recipe, or Claude where the account opted in), in a repository the plan
 * covers. A fix an older build could not make is retried once per deploy, not on every push; PRs that exist,
 * closed ones included, are left alone.
 */
export async function scansToRefix(db: Db, engine: string, opts: { llm?: boolean; billingEnforced?: boolean } = {}): Promise<{ scanId: string; repositoryId: string }[]> {
  const advisories = new Map((await reviewedAdvisories(db)).map((a) => [a.advisory.id, a.advisory]));
  const hasRecipe = (id: string) => {
    const recipeId = advisories.get(id)?.recipeId;
    return Boolean(recipeId && RECIPES[recipeId]);
  };
  const scans = await withService(db, async (tx) => {
    const latest = await tx
      .selectFrom("scans")
      .innerJoin("repositories", "repositories.id", "scans.repository_id")
      .innerJoin("accounts", "accounts.id", "scans.account_id")
      .select(["scans.id", "scans.repository_id", "scans.account_id", "scans.fix_engine", "accounts.settings"])
      .distinctOn("scans.repository_id")
      .where("scans.status", "=", "succeeded")
      .where("scans.api_lock", "is not", null)
      .where("repositories.enabled", "=", true)
      .where("accounts.suspended_at", "is", null)
      .orderBy("scans.repository_id")
      .orderBy("scans.created_at", "desc")
      .execute();
    const stale = latest.filter((s) => s.fix_engine !== engine);
    if (!stale.length) return [];
    const findings = await tx.selectFrom("findings").select(["scan_id", "advisory_id"]).where("scan_id", "in", stale.map((s) => s.id)).where("kind", "=", "affected").execute();
    const prs = await tx.selectFrom("fix_prs").select(["repository_id", "advisory_id"]).where("repository_id", "in", stale.map((s) => s.repository_id)).execute();
    const hasPr = new Set(prs.map((p) => `${p.repository_id}:${p.advisory_id}`));
    return stale
      .filter((s) => {
        const llm = opts.llm === true && (s.settings as { llmFixes?: boolean }).llmFixes === true;
        return findings.some((f) => f.scan_id === s.id && !hasPr.has(`${s.repository_id}:${f.advisory_id}`) && advisories.has(f.advisory_id) && (llm || hasRecipe(f.advisory_id)));
      })
      .map((s) => ({ scanId: s.id, repositoryId: s.repository_id, accountId: s.account_id }));
  });
  // A repository beyond the plan would only get a scan that fails as "not covered" on every deploy.
  const covered: { scanId: string; repositoryId: string }[] = [];
  for (const s of scans) {
    if ((await repositoryCovered(db, s.accountId, s.repositoryId, opts.billingEnforced ?? false)).covered) covered.push({ scanId: s.scanId, repositoryId: s.repositoryId });
  }
  return covered;
}
