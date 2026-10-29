import { withService, type Db, type Tx } from "@shapi/db";
import { sql } from "kysely";
import { STOP_LABEL, isDashboard, listInstallationRepositories, parseDashboard, type InstallationRepository } from "@shapi/github-app";
import type { GitHubClients } from "./clients";

/** The parts of GitHub's webhook payloads SHAPI reads. */
interface InstallationPayload {
  id: number;
  account: { login: string; type: string } | null;
  suspended_at?: string | null;
}

interface WebhookPayload {
  action?: string;
  installation?: InstallationPayload;
  account?: { login: string };
  repositories_removed?: { id: number }[];
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { id: number; full_name: string; default_branch: string; private: boolean; archived?: boolean };
  pull_request?: {
    number: number;
    html_url: string;
    merged: boolean;
    head: { ref: string; sha: string };
    labels: { name: string }[];
  };
  issue?: { number: number; body: string | null; pull_request?: unknown };
  sender?: { type: string };
}

export interface EventDeps {
  db: Db;
  github: GitHubClients;
}

/** A scan to start once the delivery is committed: one queued by a push, or a first scan of a newly added repository. */
export type ScanRequest = { scanId: string } | { repositoryId: string };

/** A fix job to run on a repository's latest scan once the delivery is committed. */
export interface FixRequest {
  scanId: string;
  repositoryId: string;
}

export interface ProcessResult {
  deliveryId: string;
  event: string;
  action: string | null;
  outcome: string;
  /** Scans this delivery asks for. The worker queues them after the transaction commits. */
  scans: ScanRequest[];
  /** Fix jobs this delivery asks for (a ticked dashboard box), queued the same way. */
  fixes: FixRequest[];
}

/**
 * Handle one stored webhook delivery. The delivery row is locked for the whole transaction, so a
 * duplicate job waits and then sees it already processed; a crash rolls everything back and the
 * job (or the sweeper) runs it again. The scans and fix jobs it asks for are stored with it until
 * the worker has queued them (see jobsQueued), so a retry after a failed send still queues them.
 */
export async function processDelivery(deps: EventDeps, deliveryId: string): Promise<ProcessResult> {
  try {
    return await withService(deps.db, async (tx) => {
      const row = await tx.selectFrom("webhook_deliveries").selectAll().where("delivery_id", "=", deliveryId).forUpdate().executeTakeFirst();
      if (!row) return { deliveryId, event: "unknown", action: null, outcome: "not found", scans: [], fixes: [] };
      const result = { deliveryId, event: row.event, action: row.action };
      if (row.processed_at) {
        const jobs = row.jobs as { scans: ScanRequest[]; fixes: FixRequest[] } | null;
        return { ...result, outcome: jobs ? "already processed, jobs not queued yet" : "already processed", scans: jobs?.scans ?? [], fixes: jobs?.fixes ?? [] };
      }
      const scans: ScanRequest[] = [];
      const fixes: FixRequest[] = [];
      const outcome = await handleEvent(tx, deps.github, row.event, row.payload as WebhookPayload, scans, fixes);
      const jobs = scans.length || fixes.length ? JSON.stringify({ scans, fixes }) : null;
      await tx.updateTable("webhook_deliveries").set({ processed_at: new Date(), error: null, errored_at: null, jobs }).where("delivery_id", "=", deliveryId).execute();
      return { ...result, outcome, scans, fixes };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db.updateTable("webhook_deliveries").set({ error: message.slice(0, 2000), errored_at: new Date() }).where("delivery_id", "=", deliveryId).execute();
    throw err;
  }
}

/** The worker queued every job a processed delivery asked for. */
export async function jobsQueued(db: Db, deliveryId: string): Promise<void> {
  await db.updateTable("webhook_deliveries").set({ jobs: null }).where("delivery_id", "=", deliveryId).execute();
}

async function handleEvent(tx: Tx, github: GitHubClients, event: string, payload: WebhookPayload, scans: ScanRequest[], fixes: FixRequest[]): Promise<string> {
  const installation = payload.installation;
  switch (event) {
    case "installation": {
      if (!installation) return "ignored: no installation";
      switch (payload.action) {
        case "created":
        case "new_permissions_accepted":
        case "unsuspend": {
          const accountId = await upsertAccount(tx, { ...installation, suspended_at: null });
          const repos = await syncRepositories(tx, github, accountId, installation.id, scans);
          return `account ${accountId} synced with ${repos} repositories`;
        }
        case "deleted": {
          const removed = await tx.deleteFrom("accounts").where("github_installation_id", "=", String(installation.id)).executeTakeFirst();
          return `account removed (${removed.numDeletedRows})`;
        }
        case "suspend":
          await tx
            .updateTable("accounts")
            .set({ suspended_at: installation.suspended_at ?? new Date() })
            .where("github_installation_id", "=", String(installation.id))
            .execute();
          return "account suspended";
        default:
          return `ignored: installation.${payload.action}`;
      }
    }
    case "installation_repositories": {
      if (!installation) return "ignored: no installation";
      const accountId = await ensureAccount(tx, github, installation.id, scans);
      const repos = await syncRepositories(tx, github, accountId, installation.id, scans);
      return `repositories synced (${repos})`;
    }
    case "installation_target": {
      if (!installation || !payload.account) return "ignored: no installation";
      await tx.updateTable("accounts").set({ login: payload.account.login }).where("github_installation_id", "=", String(installation.id)).execute();
      return "account renamed";
    }
    case "push":
      return handlePush(tx, github, payload, scans);
    case "pull_request":
      return handlePullRequest(tx, payload);
    case "repository":
      return handleRepository(tx, payload, scans);
    case "issues":
      return handleIssue(tx, payload, fixes);
    default:
      return `ignored: ${event}`;
  }
}

function accountType(type: string | undefined): "User" | "Organization" {
  return type === "User" ? "User" : "Organization";
}

async function upsertAccount(tx: Tx, installation: InstallationPayload): Promise<string> {
  const values = {
    login: installation.account?.login ?? `installation-${installation.id}`,
    type: accountType(installation.account?.type),
    suspended_at: installation.suspended_at ?? null,
  };
  const row = await tx
    .insertInto("accounts")
    .values({ github_installation_id: installation.id, settings: JSON.stringify({}), ...values })
    .onConflict((oc) => oc.column("github_installation_id").doUpdateSet(values))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The account for an installation, created from the GitHub API if its install event never arrived. */
async function ensureAccount(tx: Tx, github: GitHubClients, installationId: number, scans: ScanRequest[]): Promise<string> {
  const existing = await tx.selectFrom("accounts").select("id").where("github_installation_id", "=", String(installationId)).executeTakeFirst();
  if (existing) return existing.id;
  const { data } = await github.app().rest.apps.getInstallation({ installation_id: installationId });
  const account = data.account && "login" in data.account ? { login: data.account.login, type: data.account.type } : null;
  const accountId = await upsertAccount(tx, { id: installationId, account, suspended_at: data.suspended_at });
  await syncRepositories(tx, github, accountId, installationId, scans);
  return accountId;
}

/** Make the account's repositories match what the installation can see; newly added ones get a first scan. Returns how many it has. */
async function syncRepositories(tx: Tx, github: GitHubClients, accountId: string, installationId: number, scans: ScanRequest[]): Promise<number> {
  const repos = await listInstallationRepositories(github.installation(installationId));
  for (const repo of repos) {
    const { id, inserted } = await upsertRepository(tx, accountId, repo);
    if (inserted && !repo.archived) scans.push({ repositoryId: id });
  }
  let removed = tx.deleteFrom("repositories").where("account_id", "=", accountId);
  if (repos.length) removed = removed.where("github_repo_id", "not in", repos.map((r) => String(r.id)));
  await removed.execute();
  return repos.length;
}

async function upsertRepository(tx: Tx, accountId: string, repo: InstallationRepository): Promise<{ id: string; inserted: boolean }> {
  // Archived repositories are read-only on GitHub: disabled, and enabled again once unarchived (when the payload says).
  const values = {
    account_id: accountId,
    full_name: repo.full_name,
    default_branch: repo.default_branch,
    private: repo.private,
    ...(typeof repo.archived === "boolean" ? { enabled: !repo.archived } : {}),
  };
  const before = await tx.selectFrom("repositories").select("account_id").where("github_repo_id", "=", String(repo.id)).forUpdate().executeTakeFirst();
  const row = await tx
    .insertInto("repositories")
    .values({ github_repo_id: repo.id, enabled: !repo.archived, ...values })
    .onConflict((oc) => oc.column("github_repo_id").doUpdateSet(values))
    // xmax is 0 only on a freshly inserted row: tells a new repository from an updated one.
    .returning(["id", sql<boolean>`xmax = 0`.as("inserted")])
    .executeTakeFirstOrThrow();
  // Transferred to another installed account: its history moves too, so row-level security shows it to the new owner only.
  if (before && before.account_id !== accountId) {
    for (const table of ["scans", "findings", "fix_prs"] as const) {
      await tx.updateTable(table).set({ account_id: accountId }).where("repository_id", "=", row.id).execute();
    }
  }
  return { id: row.id, inserted: row.inserted };
}

/** A pending (queued) scan of one commit, unless one is pending already: the scans_pending unique index decides races. */
export async function insertPendingScan(tx: Tx, scan: { account_id: string; repository_id: string; sha: string }): Promise<{ id: string } | undefined> {
  return tx
    .insertInto("scans")
    .values({ ...scan, status: "queued" })
    .onConflict((oc) => oc.columns(["repository_id", "sha"]).where(sql<boolean>`status in ('queued', 'running')`).doNothing())
    .returning("id")
    .executeTakeFirst();
}

/** A push to a repo's default branch queues a scan of the new commit. */
async function handlePush(tx: Tx, github: GitHubClients, payload: WebhookPayload, scans: ScanRequest[]): Promise<string> {
  const { installation, repository: repo, after } = payload;
  if (!installation || !repo) return "ignored: no installation";
  if (payload.deleted || !after || /^0+$/.test(after)) return "ignored: branch deleted";
  if (payload.ref !== `refs/heads/${repo.default_branch}`) return "ignored: not the default branch";

  const accountId = await ensureAccount(tx, github, installation.id, scans);
  const account = await tx.selectFrom("accounts").select("suspended_at").where("id", "=", accountId).executeTakeFirstOrThrow();
  if (account.suspended_at) return "ignored: account suspended";

  const { id: repositoryId } = await upsertRepository(tx, accountId, repo);
  const { enabled } = await tx.selectFrom("repositories").select("enabled").where("id", "=", repositoryId).executeTakeFirstOrThrow();
  if (!enabled) return "ignored: repository disabled";

  const pending = await tx
    .selectFrom("scans")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("sha", "=", after)
    .where("status", "in", ["queued", "running"])
    .executeTakeFirst();
  if (pending) return `scan ${pending.id} already queued`;
  const scan = await insertPendingScan(tx, { account_id: accountId, repository_id: repositoryId, sha: after });
  if (!scan) return "scan already queued";
  // The push scans this commit: a first scan the same delivery asked for (lost install event) is not needed.
  const others = scans.filter((s) => !("repositoryId" in s && s.repositoryId === repositoryId));
  scans.splice(0, scans.length, ...others, { scanId: scan.id });
  return `scan ${scan.id} queued`;
}

/** An archived repository is read-only on GitHub: SHAPI stops on it, and scans it again once it is unarchived. */
async function handleRepository(tx: Tx, payload: WebhookPayload, scans: ScanRequest[]): Promise<string> {
  if (!payload.repository || (payload.action !== "archived" && payload.action !== "unarchived")) return `ignored: repository.${payload.action}`;
  const enabled = payload.action === "unarchived";
  const row = await tx.updateTable("repositories").set({ enabled }).where("github_repo_id", "=", String(payload.repository.id)).returning("id").executeTakeFirst();
  if (!row) return "ignored: unknown repository";
  if (enabled) scans.push({ repositoryId: row.id });
  return `repository ${payload.action}`;
}

/** Keep SHAPI's record of its fix PRs current: merged, closed, reopened, or stopped by label. */
async function handlePullRequest(tx: Tx, payload: WebhookPayload): Promise<string> {
  const pr = payload.pull_request;
  if (!pr || !payload.repository) return "ignored: no pull request";
  if (!pr.head.ref.startsWith("shapi/")) return "ignored: not a SHAPI branch";
  const repo = await tx.selectFrom("repositories").select("id").where("github_repo_id", "=", String(payload.repository.id)).executeTakeFirst();
  if (!repo) return "ignored: unknown repository";
  const row = await tx.selectFrom("fix_prs").select("id").where("repository_id", "=", repo.id).where("branch", "=", pr.head.ref).executeTakeFirst();
  if (!row) return "ignored: not a PR SHAPI opened";

  const now = new Date();
  const set = (() => {
    switch (payload.action) {
      case "closed":
        return pr.merged ? { state: "merged" as const, closed_at: now } : { state: "closed" as const, closed_at: now };
      case "reopened":
        return { state: "open" as const, closed_at: null };
      case "labeled":
      case "unlabeled":
        return { stopped: pr.labels.some((l) => l.name === STOP_LABEL) };
      default:
        return undefined;
    }
  })();
  if (!set) return `ignored: pull_request.${payload.action}`;
  await tx.updateTable("fix_prs").set({ ...set, number: pr.number, url: pr.html_url, updated_at: now }).where("id", "=", row.id).execute();
  return `fix PR #${pr.number} ${payload.action}`;
}

/**
 * A maintainer ticked a box on the dashboard issue: save the intent, and when it asks for a PR ("open now",
 * "open again") or lifts the pause, run the fix job on the latest scan now instead of at the next push.
 */
async function handleIssue(tx: Tx, payload: WebhookPayload, fixes: FixRequest[]): Promise<string> {
  const issue = payload.issue;
  if (!issue || issue.pull_request || !payload.repository) return "ignored: no issue";
  if (payload.action !== "edited") return `ignored: issues.${payload.action}`;
  if (payload.sender?.type === "Bot") return "ignored: edited by a bot";
  const repo = await tx
    .selectFrom("repositories")
    .select(["id", "dashboard_issue", "settings"])
    .where("github_repo_id", "=", String(payload.repository.id))
    .executeTakeFirst();
  if (!repo || repo.dashboard_issue !== issue.number || !isDashboard(issue.body)) return "ignored: not the SHAPI dashboard";
  const intents = parseDashboard(issue.body);
  const settings = { paused: intents.paused, createNow: [...intents.createNow], retry: [...intents.retry] };
  // Only the dashboard's keys: a pause set from the web app meanwhile stays.
  await tx.updateTable("repositories").set({ settings: mergeSettings(settings) }).where("id", "=", repo.id).execute();
  const unpaused = (repo.settings as { paused?: boolean }).paused === true && !intents.paused;
  const scanId = settings.createNow.length || settings.retry.length || unpaused ? await latestScanId(tx, repo.id) : undefined;
  if (scanId) fixes.push({ scanId, repositoryId: repo.id });
  return `dashboard saved (paused: ${settings.paused}, open now: ${settings.createNow.length}, retry: ${settings.retry.length})${scanId ? ", fix job queued" : ""}`;
}

/** Set some keys of repositories.settings in one statement, keeping the others as they are now (not as read earlier). */
export const mergeSettings = (keys: Record<string, unknown>) => sql<string>`repositories.settings || ${JSON.stringify(keys)}::jsonb`;

/** The repository's latest successful scan: where a fix job runs when a maintainer asks for one. */
export async function latestScanId(tx: Tx, repositoryId: string): Promise<string | undefined> {
  const row = await tx
    .selectFrom("scans")
    .select("id")
    .where("repository_id", "=", repositoryId)
    .where("status", "=", "succeeded")
    .where("api_lock", "is not", null)
    .orderBy("finished_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id;
}
