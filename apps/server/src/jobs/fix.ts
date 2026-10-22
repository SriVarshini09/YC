import { matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { withService, type Db } from "@shapi/db";
import { fetchRepoSnapshot, prTitle, renderPrBody } from "@shapi/github-app";
import { RECIPES, repairCallSite, withSandboxWorkspace, type InstallReport, type LlmFixer, type RepairResult, type Workspace } from "@shapi/repair";
import type { SandboxProvider, SnapshotFile } from "@shapi/sandbox";
import type { GitHubClients } from "../github/clients";
import { deliverRepoFixes, type DeliveryReport, type FixCandidate } from "../github/fixes";
import { reviewedAdvisories, storedLock } from "./scan";
import { shapesFor } from "./shapes";

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
  now?: () => Date;
}

export interface FixReport {
  scanId: string;
  repairs: { advisoryId: string; status: RepairResult["status"] | "no-shapes" | "no-fix"; reason?: string }[];
  delivery?: DeliveryReport;
}

/**
 * For one scan's affected call sites: repair each fixable advisory test-first inside one sandbox
 * (dependencies installed with only the npm registry reachable, then no network), and hand the
 * verified fixes to the PR engine. Advisories SHAPI cannot fix go on the dashboard as manual fixes.
 */
export async function runFixJob(deps: FixDeps, job: { scanId: string }): Promise<FixReport> {
  const now = deps.now ?? (() => new Date());
  const ctx = await withService(deps.db, async (tx) => {
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
        "repositories.full_name",
        "repositories.github_repo_id",
        "accounts.github_installation_id",
        "accounts.settings",
      ])
      .where("scans.id", "=", job.scanId)
      .executeTakeFirst();
    const findings = scan ? await tx.selectFrom("findings").selectAll().where("scan_id", "=", scan.id).where("kind", "=", "affected").orderBy("id").execute() : [];
    return { scan, findings };
  });
  const { scan } = ctx;
  if (!scan || scan.status !== "succeeded" || !scan.api_lock || !scan.github_installation_id) return { scanId: job.scanId, repairs: [] };

  const advisories = new Map((await reviewedAdvisories(deps.db)).map((a) => [a.advisory.id, a.advisory]));
  const lock = storedLock(scan.api_lock);
  const { upcoming } = matchAdvisories(lock, [...advisories.values()], { now: now() });

  // One repair per advisory (its first affected call site); the PR names how many sites it affects.
  const byAdvisory = new Map<string, { advisory: Advisory; callSite: LockedCallSite; count: number }>();
  for (const f of ctx.findings) {
    const advisory = advisories.get(f.advisory_id);
    if (!advisory) continue;
    const entry = byAdvisory.get(advisory.id);
    if (entry) entry.count++;
    else byAdvisory.set(advisory.id, { advisory, callSite: f.call_site as LockedCallSite, count: 1 });
  }

  const llm = (scan.settings as { llmFixes?: boolean }).llmFixes === true ? deps.llm : undefined;
  const report: FixReport = { scanId: scan.id, repairs: [] };
  const manual: { advisory: Advisory; callSites: number }[] = [];
  const todo: { advisory: Advisory; callSite: LockedCallSite; count: number; shapes: NonNullable<Awaited<ReturnType<typeof shapesFor>>> }[] = [];
  for (const entry of byAdvisory.values()) {
    const fixable = (entry.advisory.recipeId && RECIPES[entry.advisory.recipeId]) || llm;
    if (!fixable) {
      report.repairs.push({ advisoryId: entry.advisory.id, status: "no-fix", reason: "no recipe for this change" });
      manual.push({ advisory: entry.advisory, callSites: entry.count });
      continue;
    }
    const shapes = await shapesFor(deps.db, entry.advisory, deps.recordingsDir, deps.shapeSecret);
    if (!shapes) {
      report.repairs.push({ advisoryId: entry.advisory.id, status: "no-shapes", reason: "no before/after responses recorded for this endpoint" });
      manual.push({ advisory: entry.advisory, callSites: entry.count });
      continue;
    }
    todo.push({ ...entry, shapes });
  }

  const fixes: FixCandidate[] = [];
  if (todo.length) {
    const [owner, repo] = scan.full_name.split("/") as [string, string];
    const readOnly = await deps.github.readOnly(scan.github_installation_id, scan.github_repo_id);
    const files = await fetchRepoSnapshot(readOnly, { owner, repo, ref: scan.sha });
    await deps.workspace(files, { scan: scan.id, repository: scan.full_name }, async (ws) => {
      for (const t of todo) {
        const result = await repairCallSite({ workspace: ws, advisory: t.advisory, callSite: t.callSite, before: t.shapes.before, after: t.shapes.after, recipes: RECIPES, llm });
        report.repairs.push({ advisoryId: t.advisory.id, status: result.status, reason: result.reason });
        // Leave the workspace as it was, so the next advisory is verified against the original code.
        for (const c of result.changes) await ws.write(c.file, c.before);
        if (result.status !== "fixed") {
          if (result.status !== "already-handled") manual.push({ advisory: t.advisory, callSites: t.count });
          continue;
        }
        fixes.push({
          advisory: t.advisory,
          title: prTitle(t.advisory),
          body: renderPrBody({ advisory: t.advisory, callSite: t.callSite, result, affectedInRepo: t.count, shapeSource: t.shapes.source }),
          commitMessage: `fix: ${t.advisory.title}\n\nAdvisory ${t.advisory.id}. Contract test ${result.test?.file} fails before this change and passes after, verified in ${result.sandbox}.`,
          files: result.changes.map((c) => ({ path: c.file, content: c.after })),
        });
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
  return report;
}
