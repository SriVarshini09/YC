import { sql } from "kysely";
import { AdvisorySchema, ApiLockSchema, SEVERITY_RANK, type Advisory, type ApiLock, type LockedCallSite } from "@shapi/core";
import { withTenant, type Db, type FixOutcome, type FixRepair } from "@shapi/db";
import { RECIPES } from "@shapi/repair";
import { plural } from "./html";
import type { Health } from "./views";

/**
 * Everything the account pages read, loaded in one tenant transaction: repositories with their latest
 * scan, the findings of each repository's latest successful scan, every fix PR, the advisory database,
 * and recent scans. One account's data is small enough to load whole; the pages derive their views from it.
 * Only the repositories the signed-in user can open on GitHub are read, and only their scans, findings and PRs.
 */

export interface RepoRow {
  id: string;
  /** GitHub's id, which the session's access lists use. */
  github_repo_id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  enabled: boolean;
  created_at: Date;
  dashboard_issue: number | null;
  paused: boolean;
  pausedFromWeb: boolean;
  /** SHAPI paused itself: its last PRs here were closed without merging (U-05). */
  autoPaused?: { at: string; prs: number[] };
  /** The latest scan of any status. */
  scan?: ScanRow;
  /** From the latest successful scan's api.lock: its providers and call-site count (every page), and the lock itself (the repository page, for that repository only). */
  providers: ApiLock["providers"];
  callSites: number;
  lock?: ApiLock;
  lockSha?: string;
  /** Problems in this repository: API changes that break its code, and changes it uses that still work. */
  breaking: number;
  working: number;
  openPrs: number;
  mergedPrs: number;
}

export interface ScanRow {
  id: string;
  repository_id: string;
  sha: string;
  status: string;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface FindingRow {
  id: string;
  repository_id: string;
  repo: string;
  sha: string;
  advisory_id: string;
  kind: "affected" | "exposed";
  site: Pick<LockedCallSite, "file" | "line" | "method" | "endpoint"> & Partial<LockedCallSite>;
  reasons: string[];
  created_at: Date;
  advisory?: Advisory;
  /** What the last fix job on this scan did with this change, once one has run. */
  fix?: FixOutcome;
}

export interface PrRow {
  id: string;
  repository_id: string;
  repo: string;
  advisory_id: string;
  advisory?: Advisory;
  branch: string;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "merged";
  stopped: boolean;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  repair: FixRepair | null;
}

interface BillingRow {
  status: string;
  quantity: number;
  stripe_customer_id: string | null;
  current_period_end: Date | null;
  /** Set when the subscription is cancelled but still running: the day it ends. */
  cancel_at: Date | null;
}

/**
 * A fix PR's repair as the account pages need it: everything but the diffs (`changes` is empty) and the
 * test output. The finding page and the overview's latest catch load the full repair for one PR.
 */
const REPAIR_SUMMARY = sql<FixRepair | null>`case when fix_prs.repair is null then null else
  (fix_prs.repair - 'changes' - 'sites') || jsonb_build_object(
    'changes', '[]'::jsonb,
    'sites', coalesce((
      select jsonb_agg((s - 'before' - 'after') || jsonb_strip_nulls(jsonb_build_object('before', (s -> 'before') - 'output', 'after', (s -> 'after') - 'output')))
      from jsonb_array_elements(fix_prs.repair -> 'sites') s
    ), '[]'::jsonb)
  ) end`;

export interface AccountData {
  account: { id: string; login: string; type: string; settings: Record<string, unknown> };
  repos: RepoRow[];
  findings: FindingRow[];
  prs: PrRow[];
  advisories: Map<string, Advisory>;
  scans: (ScanRow & { repo: string })[];
  billing?: BillingRow;
  /** Every repository of the account, the user's or not, with only what the plan rules read: coverage depends on all of them. */
  planRepos: { id: string; private: boolean; enabled: boolean; created_at: Date; committers: string[] }[];
  /** The fix job asks Claude when no recipe fits: the account turned it on and the server has a key. */
  claudeFixes: boolean;
  now: Date;
}

/** SHAPI has the recipe the advisory names (an advisory may name one only a newer build has). */
export const hasRecipe = (advisory: Advisory | undefined) => Boolean(advisory?.recipeId && RECIPES[advisory.recipeId]);

/** The fix job makes a fix for this change by itself, as jobs/fix.ts decides: a recipe SHAPI has, or Claude. */
export const autoFixable = (data: Pick<AccountData, "claudeFixes">, advisory: Advisory | undefined) => Boolean(advisory && (hasRecipe(advisory) || data.claudeFixes));

/** Fix-job outcomes after which no PR comes for this scan: SHAPI tried and made no fix (the reason says why). */
const NO_PR = new Set(["unsupported", "rejected", "already-handled", "no-fix", "no-shapes", "alert", "unverified"]);
export const fixGivenUp = (fix: FixOutcome | undefined): fix is FixOutcome => Boolean(fix && NO_PR.has(fix.status));

/** The fix job's outcome for `advisoryId` in a scan's stored report. */
export const fixOutcome = (report: unknown, advisoryId: string): FixOutcome | undefined =>
  Array.isArray(report) ? (report as FixOutcome[]).find((r) => r?.advisoryId === advisoryId) : undefined;

/** Rows of the repositories in `ids` (SHAPI's ids); `= any` also takes an empty list. */
const inRepos = (ids: string[]) => sql<boolean>`repository_id = any(${ids}::bigint[])`;

/**
 * Load an account's pages' data. `readable` is the GitHub repository ids the user can open: the pages show
 * those repositories only. Only small columns are read for history: the api.lock is read for the latest
 * successful scan of each repository (its providers and size), and in full only for `lockRepo`.
 */
export async function loadAccount(db: Db, accountId: string, opts: { readable: readonly string[]; lockRepo?: string; llmAvailable?: boolean; now?: Date }): Promise<AccountData> {
  const now = opts.now ?? new Date();
  return withTenant(db, accountId, async (tx) => {
    const account = await tx.selectFrom("accounts").select(["id", "login", "type", "settings"]).where("id", "=", accountId).executeTakeFirstOrThrow();
    const allRepos = await tx.selectFrom("repositories").selectAll().orderBy("full_name").execute();
    const readable = new Set(opts.readable);
    const repoRows = allRepos.filter((r) => readable.has(String(r.github_repo_id)));
    const ids = repoRows.map((r) => r.id);
    const latest = await tx
      .selectFrom("scans")
      .select(["id", "repository_id", "sha", "status", "finished_at", "created_at", "error"])
      .where(inRepos(ids))
      .distinctOn("repository_id")
      .orderBy("repository_id")
      .orderBy("created_at", "desc")
      .execute();
    // First which scan is each repository's latest good one (small columns only), then read the lock of just those.
    const goodIds = await tx
      .selectFrom("scans")
      .select(["id", "repository_id", "sha"])
      .distinctOn("repository_id")
      .where("status", "=", "succeeded")
      .where(inRepos(ids))
      .orderBy("repository_id")
      .orderBy("created_at", "desc")
      .execute();
    const lockInfo = goodIds.length
      ? await tx
          .selectFrom("scans")
          .select([
            "id",
            sql<unknown>`api_lock->'providers'`.as("providers"),
            sql<number | null>`jsonb_array_length(api_lock->'callSites')`.as("call_sites"),
            sql<unknown>`case when repository_id = ${opts.lockRepo ?? null} then api_lock end`.as("api_lock"),
            "fix_report",
          ])
          .where("id", "in", goodIds.map((g) => g.id))
          .execute()
      : [];
    const lastGood = goodIds.map((g) => ({ ...g, ...lockInfo.find((l) => l.id === g.id) }));
    const findingRows = lastGood.length
      ? await tx
          .selectFrom("findings")
          .select(["id", "repository_id", "scan_id", "advisory_id", "kind", "call_site", "reasons", "created_at"])
          .where("scan_id", "in", lastGood.map((s) => s.id))
          .execute()
      : [];
    const prRows = await tx
      .selectFrom("fix_prs")
      .select(["id", "repository_id", "advisory_id", "branch", "number", "url", "state", "stopped", "created_at", "updated_at", "closed_at", REPAIR_SUMMARY.as("repair")])
      .where(inRepos(ids))
      .orderBy("updated_at", "desc")
      .execute();
    const advisoryRows = await tx.selectFrom("advisories").select("data").where("reviewed", "=", true).execute();
    const recent = await tx.selectFrom("scans").select(["id", "repository_id", "sha", "status", "finished_at", "created_at", "error"]).where(inRepos(ids)).orderBy("created_at", "desc").limit(25).execute();
    const billing = await tx.selectFrom("billing").select(["status", "quantity", "stripe_customer_id", "current_period_end", "cancel_at"]).executeTakeFirst();

    // Validated like the matcher does: one malformed row must not take every account page down.
    const advisories = new Map<string, Advisory>();
    for (const r of advisoryRows) {
      const a = AdvisorySchema.safeParse(r.data);
      if (a.success) advisories.set(a.data.id, a.data);
    }
    const repoName = new Map(repoRows.map((r) => [r.id, r.full_name]));
    const goodByRepo = new Map(lastGood.map((s) => [s.repository_id, s]));
    const findings: FindingRow[] = findingRows
      .map((f) => ({
        id: f.id,
        repository_id: f.repository_id,
        repo: repoName.get(f.repository_id) ?? "",
        sha: lastGood.find((s) => s.id === f.scan_id)?.sha ?? "",
        advisory_id: f.advisory_id,
        kind: f.kind,
        site: f.call_site as FindingRow["site"],
        reasons: f.reasons,
        created_at: f.created_at,
        advisory: advisories.get(f.advisory_id),
        fix: fixOutcome(lastGood.find((s) => s.id === f.scan_id)?.fix_report, f.advisory_id),
      }))
      .sort(byFinding);
    const prs: PrRow[] = prRows.map((p) => ({ ...p, repo: repoName.get(p.repository_id) ?? "", advisory: advisories.get(p.advisory_id), repair: p.repair }));
    const repos: RepoRow[] = repoRows.map((r) => {
      const good = goodByRepo.get(r.id) as { sha: string; providers: unknown; call_sites: number | null; api_lock?: unknown } | undefined;
      const settings = r.settings as { paused?: boolean; pausedFromWeb?: boolean; autoPaused?: { at: string; prs: number[] } | null };
      const lockParsed = good?.api_lock ? ApiLockSchema.safeParse(good.api_lock) : undefined;
      const providers = good?.providers ? ApiLockSchema.shape.providers.safeParse(good.providers) : undefined;
      const mine = findings.filter((f) => f.repository_id === r.id);
      const breakingIds = new Set(mine.filter((f) => f.kind === "affected").map((f) => f.advisory_id));
      const workingIds = new Set(mine.filter((f) => f.kind === "exposed" && !breakingIds.has(f.advisory_id)).map((f) => f.advisory_id));
      return {
        id: r.id,
        github_repo_id: String(r.github_repo_id),
        full_name: r.full_name,
        default_branch: r.default_branch,
        private: r.private,
        enabled: r.enabled,
        created_at: r.created_at,
        dashboard_issue: r.dashboard_issue,
        paused: settings.paused === true,
        pausedFromWeb: settings.pausedFromWeb === true,
        ...(settings.paused === true && settings.autoPaused ? { autoPaused: settings.autoPaused } : {}),
        scan: latest.find((s) => s.repository_id === r.id),
        providers: providers?.success ? providers.data : [],
        callSites: Number(good?.call_sites ?? 0),
        lock: lockParsed?.success ? lockParsed.data : undefined,
        lockSha: good?.sha,
        breaking: breakingIds.size,
        working: workingIds.size,
        openPrs: prs.filter((p) => p.repository_id === r.id && p.state === "open").length,
        mergedPrs: prs.filter((p) => p.repository_id === r.id && p.state === "merged").length,
      };
    });
    const planRepos = allRepos.map((r) => ({ id: r.id, private: r.private, enabled: r.enabled, created_at: r.created_at, committers: r.committers ?? [] }));
    return { account, repos, findings, prs, advisories, scans: recent.map((s) => ({ ...s, repo: repoName.get(s.repository_id) ?? "" })), billing, planRepos, claudeFixes: opts.llmAvailable === true && (account.settings as { llmFixes?: boolean }).llmFixes === true, now };
  });
}

function byFinding(a: FindingRow, b: FindingRow): number {
  const rank = (f: FindingRow) => (f.advisory ? SEVERITY_RANK[f.advisory.severity] : 9);
  return (a.kind === b.kind ? 0 : a.kind === "affected" ? -1 : 1) || rank(a) - rank(b) || a.repo.localeCompare(b.repo) || a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line;
}

/**
 * One finding with what its page needs: the repository, the advisory, the call site's surface, and the fix PR
 * for it. Undefined unless its repository is among `readable` (GitHub ids). The advisory is validated and
 * reviewed like loadAccount's, or left out.
 */
export async function loadFinding(db: Db, accountId: string, findingId: string, readable: readonly string[]) {
  return withTenant(db, accountId, async (tx) => {
    const f = await tx
      .selectFrom("findings")
      .innerJoin("scans", "scans.id", "findings.scan_id")
      .innerJoin("repositories", "repositories.id", "findings.repository_id")
      .leftJoin("advisories", "advisories.id", "findings.advisory_id")
      .select([
        "findings.id",
        "findings.kind",
        "findings.call_site",
        "findings.reasons",
        "findings.advisory_id",
        "findings.created_at",
        "findings.scan_id",
        "scans.sha",
        "scans.api_lock",
        "scans.finished_at",
        "scans.fix_report",
        "repositories.id as repository_id",
        "repositories.full_name",
        "repositories.default_branch",
        "advisories.data as advisory",
        "advisories.reviewed",
      ])
      .where("findings.id", "=", findingId)
      .where(sql<boolean>`repositories.github_repo_id = any(${[...readable]}::bigint[])`)
      .executeTakeFirst();
    if (!f) return undefined;
    const pr = await tx.selectFrom("fix_prs").selectAll().where("repository_id", "=", f.repository_id).where("advisory_id", "=", f.advisory_id).executeTakeFirst();
    const site = f.call_site as FindingRow["site"];
    const lock = f.api_lock ? ApiLockSchema.safeParse(f.api_lock) : undefined;
    const locked = lock?.success ? lock.data.callSites.find((c) => c.file === site.file && c.line === site.line) : undefined;
    // The same problem elsewhere in this repository: same scan, same API change.
    const siblings = await tx.selectFrom("findings").select(["id", "kind", "call_site"]).where("scan_id", "=", f.scan_id).where("advisory_id", "=", f.advisory_id).where("id", "!=", f.id).orderBy("id").execute();
    const others = siblings.map((o) => ({ id: o.id, kind: o.kind, file: (o.call_site as FindingRow["site"]).file, line: (o.call_site as FindingRow["site"]).line }));
    const advisory = f.reviewed ? AdvisorySchema.safeParse(f.advisory) : undefined;
    const { fix_report, ...rest } = f;
    return { ...rest, site, locked, others, advisory: advisory?.success ? advisory.data : undefined, fix: fixOutcome(fix_report, f.advisory_id), pr: pr ? { ...pr, repair: pr.repair } : undefined };
  });
}

/* ---------- derived views ---------- */

const DAY = 86_400_000;
export const daysUntil = (date: string, now: Date) => Math.round((Date.parse(date) - Math.floor(now.getTime() / DAY) * DAY) / DAY);

/** Providers in the account's code (from the latest api.lock of each repository), with how they stand. */
export function providersOf(data: AccountData) {
  const map = new Map<string, { id: string; callSites: number; repos: number; breaking: number; working: number; nextDeadline?: number }>();
  for (const r of data.repos) {
    for (const p of r.providers) {
      const e = map.get(p.id) ?? { id: p.id, callSites: 0, repos: 0, breaking: 0, working: 0 };
      e.callSites += p.callSites;
      e.repos += 1;
      map.set(p.id, e);
    }
  }
  for (const p of problemsOf(data)) {
    const id = p.advisory?.provider ?? p.places[0]?.site.provider;
    if (!id) continue;
    const e = map.get(id) ?? { id, callSites: 0, repos: 0, breaking: 0, working: 0 };
    if (p.status === "breaks") e.breaking++;
    else e.working++;
    map.set(id, e);
  }
  for (const d of deadlinesOf(data)) {
    const e = map.get(d.advisory.provider);
    if (e && d.daysUntil >= 0 && (e.nextDeadline === undefined || d.daysUntil < e.nextDeadline)) e.nextDeadline = d.daysUntil;
  }
  return [...map.values()].sort((a, b) => b.breaking - a.breaking || b.working - a.working || b.callSites - a.callSites || a.id.localeCompare(b.id));
}

/**
 * The API changes that matter to this account: every upcoming one for a provider in its code, and any
 * in effect that still touches its code. Sorted by date. Counts are problems (repositories), not lines.
 */
export function deadlinesOf(data: AccountData) {
  const present = new Set(data.repos.flatMap((r) => r.providers.map((p) => p.id)));
  for (const f of data.findings) if (f.advisory) present.add(f.advisory.provider);
  const hits = hitsByAdvisory(data);
  return [...data.advisories.values()]
    .filter((a) => present.has(a.provider))
    .map((a) => ({ advisory: a, daysUntil: daysUntil(a.effectiveDate, data.now), ...(hits.get(a.id) ?? { breaking: 0, working: 0 }) }))
    .filter((d) => d.daysUntil >= 0 || d.breaking || d.working)
    .sort((a, b) => a.daysUntil - b.daysUntil || SEVERITY_RANK[a.advisory.severity] - SEVERITY_RANK[b.advisory.severity]);
}

/** Problems per API change: in how many repositories it breaks the code, and in how many the code still works. */
export function hitsByAdvisory(data: AccountData): Map<string, { breaking: number; working: number }> {
  const hits = new Map<string, { breaking: number; working: number }>();
  for (const p of problemsOf(data)) {
    const h = hits.get(p.advisory_id) ?? { breaking: 0, working: 0 };
    if (p.status === "breaks") h.breaking++;
    else h.working++;
    hits.set(p.advisory_id, h);
  }
  return hits;
}

/**
 * The unit every page counts: one API change in one repository. It "breaks" when any place in that
 * repository's code depends on what changed, and "works" when the code only calls the changed API.
 */
export interface Problem {
  key: string;
  repository_id: string;
  repo: string;
  advisory_id: string;
  advisory?: Advisory;
  status: "breaks" | "works";
  /** Every place in the code it touches, the breaking ones first. */
  places: FindingRow[];
  pr?: PrRow;
}

const problemCache = new WeakMap<AccountData, Problem[]>();

/** The account's problems, breaking ones first, then by severity. */
export function problemsOf(data: AccountData): Problem[] {
  const cached = problemCache.get(data);
  if (cached) return cached;
  const byKey = new Map<string, Problem>();
  for (const f of data.findings) {
    const key = pairKey(f.repository_id, f.advisory_id);
    let p = byKey.get(key);
    if (!p) {
      p = { key, repository_id: f.repository_id, repo: f.repo, advisory_id: f.advisory_id, advisory: f.advisory, status: "works", places: [], pr: data.prs.find((pr) => pairKey(pr.repository_id, pr.advisory_id) === key) };
      byKey.set(key, p);
    }
    p.places.push(f);
    if (f.kind === "affected") p.status = "breaks";
  }
  const rank = (a?: Advisory) => (a ? SEVERITY_RANK[a.severity] : 9);
  for (const p of byKey.values()) p.places.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "affected" ? -1 : 1));
  const list = [...byKey.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === "breaks" ? -1 : 1) || rank(a.advisory) - rank(b.advisory) || a.repo.localeCompare(b.repo));
  problemCache.set(data, list);
  return list;
}

/** Problems that break code now: the number the sidebar and the Problems page show. */
export const openProblems = (data: AccountData) => problemsOf(data).filter((p) => p.status === "breaks");

const SEVERITY_COST: Record<string, number> = { critical: 8, high: 5, medium: 3, low: 1 };

/**
 * One number for the account: the share of its API calls that still work (100 when none breaks), less
 * a little per breaking call by severity (at most 15) and 5 per repository whose last scan failed.
 * Calls that use a changed API but still work cost nothing. The explanation counts problems.
 */
export function healthOf(data: AccountData): Health {
  const scanned = data.repos.filter((r) => r.lockSha);
  if (!scanned.length) return { score: null, verdict: "No scan yet", why: "The score appears after the first scan." };
  const affected = data.findings.filter((f) => f.kind === "affected");
  const failed = data.repos.filter((r) => r.scan?.status === "failed").length;
  const callSites = Math.max(1, scanned.reduce((n, r) => n + r.callSites, 0));
  const share = 100 * (1 - Math.min(affected.length, callSites) / callSites);
  const severity = Math.min(15, affected.reduce((n, f) => n + (SEVERITY_COST[f.advisory?.severity ?? "medium"] ?? 3), 0));
  const score = Math.max(0, Math.round(share - severity - failed * 5));
  const open = openProblems(data).length;
  const parts = [open ? plural(open, "open problem") : "No open problems"];
  if (failed) parts.push(`${failed} scan${failed === 1 ? "" : "s"} failed`);
  const verdict = !affected.length && !failed ? "Healthy" : score >= 55 ? "Needs attention" : "At risk";
  return { score, verdict, why: parts.join(" · ") };
}

/* ---------- what the overview leads with ---------- */

const pairKey = (repositoryId: string, advisoryId: string) => `${repositoryId}:${advisoryId}`;

/**
 * What SHAPI found and did, counted once per repository and API change: every change that affects a
 * call site now or got a fix PR, how many fixes merged, how many PRs wait for review, and how many
 * affected changes have neither an open nor a merged PR.
 */
export function valueOf(data: AccountData): { caught: number; merged: number; review: number; open: number } {
  const caught = new Set<string>();
  for (const f of data.findings) if (f.kind === "affected") caught.add(pairKey(f.repository_id, f.advisory_id));
  for (const p of data.prs) caught.add(pairKey(p.repository_id, p.advisory_id));
  const handled = new Set(data.prs.filter((p) => p.state !== "closed").map((p) => pairKey(p.repository_id, p.advisory_id)));
  const open = new Set(data.findings.filter((f) => f.kind === "affected").map((f) => pairKey(f.repository_id, f.advisory_id)).filter((k) => !handled.has(k)));
  return { caught: caught.size, merged: data.prs.filter((p) => p.state === "merged").length, review: data.prs.filter((p) => p.state === "open").length, open: open.size };
}

export type AttentionItem =
  | { kind: "review"; pr: PrRow }
  | { kind: "manual" | "pending"; finding: FindingRow }
  | { kind: "closed"; finding: FindingRow; pr: PrRow }
  | { kind: "scan-failed"; repo: RepoRow }
  | { kind: "deadline"; deadline: ReturnType<typeof deadlinesOf>[number] };

const ATTENTION_ORDER: Record<AttentionItem["kind"], number> = { review: 0, manual: 1, closed: 2, "scan-failed": 3, deadline: 4, pending: 5 };

/**
 * What needs a person, most pressing first: fix PRs to review, affected changes with no automatic fix,
 * fixes that were closed unmerged, failed scans, changes due within 30 days that touch the code, and
 * last the fixes SHAPI will still open by itself.
 */
export function attentionOf(data: AccountData): AttentionItem[] {
  const rank = (a?: Advisory) => (a ? SEVERITY_RANK[a.severity] : 9);
  const items: AttentionItem[] = data.prs
    .filter((p) => p.state === "open")
    .sort((a, b) => rank(a.advisory) - rank(b.advisory))
    .map((pr) => ({ kind: "review" as const, pr }));
  const seen = new Set<string>();
  for (const f of data.findings) {
    const key = pairKey(f.repository_id, f.advisory_id);
    if (f.kind !== "affected" || seen.has(key)) continue;
    seen.add(key);
    const pr = data.prs.find((p) => pairKey(p.repository_id, p.advisory_id) === key);
    if (pr && pr.state !== "closed") continue;
    items.push(pr ? { kind: "closed", finding: f, pr } : { kind: autoFixable(data, f.advisory) && !fixGivenUp(f.fix) ? "pending" : "manual", finding: f });
  }
  for (const repo of data.repos) if (repo.scan?.status === "failed") items.push({ kind: "scan-failed", repo });
  for (const deadline of deadlinesOf(data)) if (deadline.daysUntil >= 0 && deadline.daysUntil <= 30 && (deadline.breaking || deadline.working)) items.push({ kind: "deadline", deadline });
  return items.sort((a, b) => ATTENTION_ORDER[a.kind] - ATTENTION_ORDER[b.kind]);
}

export interface LatestCatch {
  pr?: PrRow;
  finding?: FindingRow;
}

/** The newest fix PR with a verified fix and its finding, or else the most severe affected finding. */
export function latestCatchOf(data: AccountData): LatestCatch | undefined {
  const pair = (repositoryId: string, advisoryId: string) => (x: { repository_id: string; advisory_id: string }) => x.repository_id === repositoryId && x.advisory_id === advisoryId;
  const pr = data.prs.filter((p) => p.repair?.sites.some((s) => s.status === "fixed")).sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
  if (pr) return { pr, finding: data.findings.find(pair(pr.repository_id, pr.advisory_id)) };
  const finding = data.findings.find((f) => f.kind === "affected");
  return finding ? { finding, pr: data.prs.find(pair(finding.repository_id, finding.advisory_id)) } : undefined;
}

/** How long a new repository with no scan row yet counts as waiting for its first scan. */
const FIRST_SCAN_GRACE_MS = 15 * 60_000;

/**
 * Repositories are installed, none has finished a scan, and a first scan is still on its way: the overview
 * shows scan progress (and refreshes) instead. Once every first scan has failed, or a repository has waited
 * past the grace period with no scan at all, it stops: the overview shows the failures to act on.
 */
export const firstScanPending = (data: AccountData) =>
  data.repos.length > 0 &&
  !data.repos.some((r) => r.lockSha) &&
  data.repos.some(
    (r) => r.scan?.status === "queued" || r.scan?.status === "running" || (!r.scan && data.now.getTime() - r.created_at.getTime() < FIRST_SCAN_GRACE_MS),
  );

/** The overview's latest catch with its full repair (diffs included), which loadAccount leaves out. */
export async function withCatchDetail(db: Db, data: AccountData): Promise<AccountData> {
  const pr = latestCatchOf(data)?.pr;
  if (!pr?.repair) return data;
  const row = await withTenant(db, data.account.id, (tx) => tx.selectFrom("fix_prs").select("repair").where("id", "=", pr.id).executeTakeFirst());
  return row?.repair ? { ...data, prs: data.prs.map((p) => (p.id === pr.id ? { ...p, repair: row.repair as FixRepair } : p)) } : data;
}

interface SetupStep {
  key: "install" | "scan" | "slack" | "fix";
  state: "done" | "active" | "todo";
  label: string;
  detail: string;
}

export interface Setup {
  steps: SetupStep[];
  done: number;
  complete: boolean;
}

/** The first-run checklist: install, first scan, Slack alerts, first merged fix. */
export function setupOf(data: AccountData): Setup {
  const total = data.repos.length;
  const scanned = data.repos.filter((r) => r.lockSha).length;
  const scanning = data.repos.filter((r) => r.scan?.status === "queued" || r.scan?.status === "running").length;
  const merged = data.prs.some((p) => p.state === "merged");
  const open = data.prs.some((p) => p.state === "open");
  const affected = data.findings.some((f) => f.kind === "affected");
  const slack = Boolean((data.account.settings as { slackWebhookUrl?: string }).slackWebhookUrl);
  const steps: SetupStep[] = [
    total
      ? { key: "install", state: "done", label: "Install SHAPI on your repositories", detail: `${plural(total, "repository", "repositories")} connected` }
      : { key: "install", state: "active", label: "Install SHAPI on your repositories", detail: "Pick the repositories SHAPI should watch on GitHub." },
    scanned
      ? { key: "scan", state: "done", label: "First scan", detail: `${scanned} of ${plural(total, "repository", "repositories")} scanned` }
      : scanning
        ? { key: "scan", state: "active", label: "First scan", detail: `Scanning ${scanning} of ${plural(total, "repository", "repositories")} now` }
        : { key: "scan", state: "todo", label: "First scan", detail: total ? "Waiting to start. Scans begin when SHAPI is installed and on every push." : "Starts as soon as a repository is connected." },
    slack
      ? { key: "slack", state: "done", label: "Turn on Slack alerts", detail: "Alerts go to your Slack channel" }
      : { key: "slack", state: "todo", label: "Turn on Slack alerts", detail: "Hear about a breaking change the moment it hits your code." },
    merged
      ? { key: "fix", state: "done", label: "Merge your first verified fix", detail: "A tested fix is in your code" }
      : open
        ? { key: "fix", state: "active", label: "Merge your first verified fix", detail: "A fix PR is ready: its test failed before the change and passes after." }
        : scanned && !affected
          ? { key: "fix", state: "done", label: "Merge your first verified fix", detail: "Nothing to fix yet. SHAPI opens a PR when an API change hits your code." }
          : { key: "fix", state: "todo", label: "Merge your first verified fix", detail: "Appears after a scan finds a problem." },
  ];
  const done = steps.filter((s) => s.state === "done").length;
  return { steps, done, complete: done === steps.length };
}
