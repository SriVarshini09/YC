import type { Advisory } from "@shapi/core";
import { withService, type Db, type FixRepair, type Tx } from "@shapi/db";
import {
  DEFAULT_PR_LIMITS,
  parseDashboard,
  planFixPrs,
  prBranch,
  readDashboard,
  renderDashboard,
  upsertDashboard,
  upsertFixPr,
  type DashboardInput,
  type ExistingFixPr,
  type FixPrOutcome,
  type PrLimits,
} from "@shapi/github-app";
import { AdvisorySchema } from "@shapi/core";
import type { GitHubClients } from "./clients";
import { mergeSettings } from "./events";

/** A verified fix ready to deliver: produced by the scan and repair jobs (A5). */
export interface FixCandidate {
  advisory: Advisory;
  title: string;
  body: string;
  commitMessage: string;
  files: { path: string; content: string }[];
  /** How the fix was verified, shown in the web app; absent for fixes built outside the fix job. */
  repair?: FixRepair;
}

export interface DeliverInput {
  repositoryId: string;
  fixes: FixCandidate[];
  /** Affected call sites SHAPI cannot fix automatically, and deadlines coming up, for the dashboard. */
  manual?: DashboardInput["manual"];
  upcoming?: DashboardInput["upcoming"];
  now?: Date;
}

export interface DeliveryReport {
  repository: string;
  outcomes: { advisoryId: string; action: string; reason?: string; url?: string }[];
  dashboard?: { number: number; action: string };
  errors: string[];
}

/** Label put on every SHAPI fix PR. */
export const PR_LABEL = "shapi";

/**
 * Deliver one repository's ready fixes as PRs under the noise policy, record each PR, then refresh
 * the dashboard issue. Every step is idempotent, so a retried job only finishes what is left.
 */
export async function deliverRepoFixes(deps: { db: Db; github: GitHubClients }, input: DeliverInput): Promise<DeliveryReport> {
  const now = input.now ?? new Date();
  const ctx = await withService(deps.db, async (tx) => {
    const repo = await tx
      .selectFrom("repositories")
      .innerJoin("accounts", "accounts.id", "repositories.account_id")
      .select([
        "repositories.id",
        "repositories.account_id",
        "repositories.full_name",
        "repositories.enabled",
        "repositories.settings",
        "repositories.dashboard_issue",
        "accounts.github_installation_id",
        "accounts.settings as account_settings",
        "accounts.suspended_at",
      ])
      .where("repositories.id", "=", input.repositoryId)
      .executeTakeFirstOrThrow();
    const prs = await tx.selectFrom("fix_prs").selectAll().where("repository_id", "=", input.repositoryId).execute();
    return { repo, prs };
  });
  const { repo } = ctx;
  const report: DeliveryReport = { repository: repo.full_name, outcomes: [], errors: [] };
  if (!repo.enabled || repo.suspended_at || !repo.github_installation_id) {
    report.errors.push("repository disabled or account suspended");
    return report;
  }

  const octokit = deps.github.installation(repo.github_installation_id);
  const [owner, name] = repo.full_name.split("/") as [string, string];
  const dashboard = repo.dashboard_issue ? await readDashboard(octokit, owner, name, repo.dashboard_issue) : undefined;
  // The issue's checkboxes are the source of truth; settings hold the last state seen from its events.
  const saved = repo.settings as { paused?: boolean; createNow?: string[]; retry?: string[]; pausedFromWeb?: boolean };
  const pausedFromWeb = saved.pausedFromWeb === true;
  const intents = dashboard
    ? parseDashboard(dashboard.body)
    : { paused: saved.paused ?? false, createNow: new Set(saved.createNow ?? []), retry: new Set(saved.retry ?? []) };
  const limits: PrLimits = { ...DEFAULT_PR_LIMITS, ...((repo.account_settings as { prLimits?: Partial<PrLimits> }).prLimits ?? {}) };

  const existing = new Map<string, ExistingFixPr>(ctx.prs.map((p) => [p.advisory_id, { state: p.state, stopped: p.stopped }]));
  const hourAgo = new Date(now.getTime() - 3600_000);
  const decisions = planFixPrs({
    candidates: input.fixes.map((f) => f.advisory),
    existing,
    openCount: ctx.prs.filter((p) => p.state === "open").length,
    createdLastHour: ctx.prs.filter((p) => p.created_at > hourAgo).length,
    limits,
    paused: intents.paused || pausedFromWeb,
    pausedReason: pausedFromWeb ? "paused from the web app" : undefined,
    createNow: intents.createNow,
    retry: intents.retry,
  });

  const waiting: DashboardInput["waiting"] = [];
  for (const d of decisions) {
    const fix = input.fixes.find((f) => f.advisory.id === d.advisory.id)!;
    if (d.action === "wait" || d.action === "skip") {
      // An open PR that waits (paused) is already listed as open; only new fixes get an "open now" box.
      if (d.action === "wait" && existing.get(d.advisory.id)?.state !== "open") waiting.push({ advisory: d.advisory, reason: d.reason ?? "waiting" });
      report.outcomes.push({ advisoryId: d.advisory.id, action: d.action, reason: d.reason });
      continue;
    }
    try {
      const outcome = await upsertFixPr(octokit, { repo: repo.full_name, branch: prBranch(d.advisory), title: fix.title, body: fix.body, commitMessage: fix.commitMessage, files: fix.files, labels: [PR_LABEL], retryClosed: intents.retry.has(d.advisory.id) });
      await withService(deps.db, (tx) => recordOutcome(tx, repo, d.advisory.id, outcome, now, fix.repair));
      if (outcome.action === "skipped" && !outcome.state) waiting.push({ advisory: d.advisory, reason: outcome.reason });
      report.outcomes.push({ advisoryId: d.advisory.id, action: outcome.action, reason: outcome.action === "skipped" ? outcome.reason : undefined, url: outcome.url });
    } catch (err) {
      report.errors.push(`${d.advisory.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dashboard: everything SHAPI knows about this repository's fix PRs.
  const rows = await withService(deps.db, (tx) => tx.selectFrom("fix_prs").selectAll().where("repository_id", "=", repo.id).orderBy("advisory_id").execute());
  const advisories = await advisoryLookup(deps.db, input, rows.map((r) => r.advisory_id));
  const known = (id: string) => advisories.get(id);
  const body = renderDashboard({
    open: rows.filter((r) => r.state === "open" && r.number && r.url && known(r.advisory_id)).map((r) => ({ advisory: known(r.advisory_id)!, number: r.number!, url: r.url!, stopped: r.stopped })),
    waiting,
    closed: rows.filter((r) => r.state === "closed" && known(r.advisory_id)).map((r) => ({ advisory: known(r.advisory_id)!, number: r.number ?? undefined, url: r.url ?? undefined })),
    manual: input.manual ?? [],
    upcoming: input.upcoming ?? [],
    paused: intents.paused,
    pausedFromWeb,
    limits,
  });
  try {
    // A box ticked on the issue during this run stays ticked in the new body (see upsertDashboard), for the next job.
    const { body: shown, ...issue } = await upsertDashboard(octokit, { owner, repo: name, issueNumber: repo.dashboard_issue }, body, dashboard ? intents : undefined);
    report.dashboard = issue;
    // Ticked "open now" and "retry" boxes have been acted on; the new body shows them unticked. Only these keys are
    // written, so a pause set from the web app while the job ran is kept.
    const left = parseDashboard(shown);
    const settings = mergeSettings({ paused: left.paused, createNow: [...left.createNow], retry: [...left.retry] });
    await withService(deps.db, (tx) => tx.updateTable("repositories").set({ dashboard_issue: issue.number, settings }).where("id", "=", repo.id).execute());
  } catch (err) {
    report.errors.push(`dashboard: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (report.errors.length) throw Object.assign(new Error(`fix delivery for ${repo.full_name} failed: ${report.errors.join("; ")}`), { report });
  return report;
}

async function recordOutcome(tx: Tx, repo: { id: string; account_id: string }, advisoryId: string, outcome: FixPrOutcome, now: Date, repair: FixRepair | undefined): Promise<void> {
  if (outcome.action === "skipped" && !outcome.state) return; // a foreign branch: nothing SHAPI owns
  const state = outcome.action === "skipped" ? outcome.state! : "open";
  const values = {
    branch: outcome.branch,
    number: outcome.number ?? null,
    url: outcome.url ?? null,
    state,
    stopped: outcome.action === "skipped" && outcome.state === "open",
    head_sha: "commit" in outcome ? outcome.commit : null,
    updated_at: now,
    closed_at: state === "closed" ? now : null,
    // The verification behind the PR's current head. Every run that reaches the PR rewrites it, an unchanged
    // PR included (same code, verified again now); a PR SHAPI skipped keeps what it had.
    ...(repair && "commit" in outcome ? { repair: JSON.stringify(repair) } : {}),
  };
  const created = outcome.action === "created";
  await tx
    .insertInto("fix_prs")
    .values({ account_id: repo.account_id, repository_id: repo.id, advisory_id: advisoryId, created_at: now, ...values })
    .onConflict((oc) => oc.columns(["repository_id", "advisory_id"]).doUpdateSet(created ? { ...values, created_at: now } : values))
    .execute();
}

/** Advisories for the dashboard: this run's candidates first, then the advisory database. */
async function advisoryLookup(db: Db, input: DeliverInput, ids: string[]): Promise<Map<string, Advisory>> {
  const map = new Map<string, Advisory>([...input.fixes, ...(input.manual ?? []), ...(input.upcoming ?? [])].map((x) => [x.advisory.id, x.advisory]));
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) {
    const rows = await db.selectFrom("advisories").select(["id", "data"]).where("id", "in", missing).execute();
    for (const r of rows) {
      const parsed = AdvisorySchema.safeParse(r.data);
      if (parsed.success) map.set(r.id, parsed.data);
    }
  }
  return map;
}
