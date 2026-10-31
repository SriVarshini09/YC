import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb, migrateToLatest, upsertAdvisories, withService, type Db } from "@shapi/db";
import { loadAdvisories, matchAdvisories } from "@shapi/core";
import { localWorkspace } from "@shapi/repair";
import { SandboxLifetimeError } from "@shapi/sandbox";
import { fakeRepoGitHub } from "../../../test-utils/fake-github";
import { slackMessage, slackNotifier, type FindingsNotice } from "../src/notify/slack";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import {
  QUEUES,
  githubClients,
  insertPendingScan,
  processDelivery,
  runAdvisoryFanout,
  runFixJob,
  QUEUE_OPTIONS,
  runScanJob,
  scansToRefix,
  settleDeadJob,
  staleQueuedScans,
  startWorker,
  stopHungScans,
  syncAdvisoriesJob,
  type WorkspaceRunner,
} from "../src/index";
import { latestScanId } from "../src/github/events";
import { reviewedAdvisories, storedLock } from "../src/jobs/scan";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADVISORIES = path.join(root, "advisories");
const RECORDINGS = path.join(root, "fixtures", "recordings");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const githubApp = { appId: "1", privateKey, webhookSecret: "s" };
const INSTALLATION = 4242;
const REPO_ID = 777;
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-cloud-"));

let pg: TestPostgres;
let db: Db;
let owner: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_cloud");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
  await syncAdvisoriesJob(db, ADVISORIES);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
  rmSync(tmp, { recursive: true, force: true });
}, 60_000);

/** The demo service (GitHub, Stripe, QuickBooks and HubSpot call sites) as the repository's files. */
function demoFiles(): Record<string, string> {
  const dir = path.join(root, "fixtures", "demo-ts");
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, child)).isDirectory()) walk(child);
      else if (name !== "api.lock") out[child] = readFileSync(path.join(dir, child), "utf8");
    }
  };
  walk("");
  return out;
}

let repositoryId: string;
beforeEach(async () => {
  await owner.deleteFrom("accounts").execute();
  const account = await owner
    .insertInto("accounts")
    .values({ github_installation_id: INSTALLATION, login: "acme", type: "Organization", settings: JSON.stringify({}) })
    .returning("id")
    .executeTakeFirstOrThrow();
  const repo = await owner
    .insertInto("repositories")
    .values({ account_id: account.id, github_repo_id: REPO_ID, full_name: "acme/demo", default_branch: "main", private: true })
    .returning("id")
    .executeTakeFirstOrThrow();
  repositoryId = repo.id;
});

function setup(extra: Record<string, string> = {}) {
  const fake = fakeRepoGitHub("acme/demo", { ...demoFiles(), ...extra }, { repoId: REPO_ID });
  const github = githubClients({ appId: githubApp.appId, privateKey }, { fetch: fake.fetch, resilient: false });
  /** Fixes are verified in a local copy here; production runs the same steps in an E2B sandbox. */
  const runs: string[] = [];
  /** What a job left in its workspace: repository files whose text changed, and contract tests still there. */
  const leftovers: string[] = [];
  const workspace: WorkspaceRunner = async (files, labels, fn) => {
    runs.push(labels.repository!);
    const dir = mkdtempSync(path.join(tmp, "ws-"));
    for (const f of files) {
      mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      writeFileSync(path.join(dir, f.path), f.content);
    }
    const ws = localWorkspace(dir);
    const result = await fn(ws);
    for (const f of files) if (readFileSync(path.join(ws.location, f.path), "utf8") !== String(f.content)) leftovers.push(f.path);
    const tests = path.join(ws.location, "test", "shapi");
    if (existsSync(tests)) for (const name of readdirSync(tests)) leftovers.push(`test/shapi/${name}`);
    await ws.dispose();
    return result;
  };
  return { ...fake, githubClients: github, workspace, runs, leftovers, fixDeps: { db, github, workspace, recordingsDir: RECORDINGS, shapeSecret: "test" } };
}

async function queueScan(sha: string) {
  const scan = await withService(db, async (tx) => {
    const repo = await tx.selectFrom("repositories").select(["id", "account_id"]).where("id", "=", repositoryId).executeTakeFirstOrThrow();
    return tx.insertInto("scans").values({ account_id: repo.account_id, repository_id: repo.id, sha, status: "queued" }).returning("id").executeTakeFirstOrThrow();
  });
  return scan.id;
}

describe("cloud scan", () => {
  it("links the SHAPI check to the repository's page in the web app (U-02)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients, publicUrl: "https://app.shapi.dev/" }, { scanId });
    const created = t.github.calls.find((c) => c.method === "POST" && c.path === "/repos/acme/demo/check-runs");
    const detailsUrl = (created?.body as { details_url?: string } | undefined)?.details_url ?? "";
    expect(detailsUrl.startsWith("https://app.shapi.dev/a/")).toBe(true);
    expect(detailsUrl.endsWith(`/r/${repositoryId}`)).toBe(true);
  });

  it("fails a repository too large to scan, says why on the check, and does not leave the scan running (I-01)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    const report = await runScanJob({ db, github: t.githubClients, scanLimits: { maxSourceBytes: 10 } }, { scanId });
    expect(report.status).toBe("failed");
    const scan = await withService(db, (tx) => tx.selectFrom("scans").select(["status", "error", "finished_at"]).where("id", "=", scanId).executeTakeFirstOrThrow());
    expect(scan.status).toBe("failed");
    expect(scan.error).toMatch(/of TypeScript, JavaScript and Python source; SHAPI scans up to 0\.0 MB for now/);
    expect(scan.finished_at).not.toBeNull();
    const completed = t.github.calls.find((c) => c.method === "PATCH" && /\/check-runs\/\d+$/.test(c.path));
    expect(JSON.stringify(completed?.body)).toContain("SHAPI scans up to");
  }, 60_000);

  it("scans a commit with a read-only token, stores findings, and posts the SHAPI check", async () => {
    const t = setup();
    const sha = t.github.refs.get("main")!;
    const scanId = await queueScan(sha);
    const report = await runScanJob({ db, github: t.githubClients }, { scanId });
    expect(report).toMatchObject({ status: "succeeded", repositoryId, fix: true });
    expect(report.affected).toBeGreaterThanOrEqual(3);

    // the code was downloaded with a token scoped to this repository's contents, read-only
    const tokenRequest = t.github.calls.find((c) => c.path.endsWith("/access_tokens") && (c.body as { repository_ids?: number[] })?.repository_ids);
    expect(tokenRequest?.body).toEqual({ repository_ids: [REPO_ID], permissions: { metadata: "read", contents: "read" } });
    expect(t.github.calls.some((c) => c.path === `/repos/acme/demo/tarball/${sha}`)).toBe(true);

    const stored = await withService(db, async (tx) => ({
      scan: await tx.selectFrom("scans").select(["status", "check_run_id", "advisories"]).where("id", "=", scanId).executeTakeFirstOrThrow(),
      findings: await tx.selectFrom("findings").select(["advisory_id", "kind"]).where("scan_id", "=", scanId).execute(),
      repo: await tx.selectFrom("repositories").select("last_scan_sha").where("id", "=", repositoryId).executeTakeFirstOrThrow(),
    }));
    expect(stored.scan.status).toBe("succeeded");
    expect(Object.keys(stored.scan.advisories)).toContain("github-workflow-dispatch-204-to-200");
    expect(stored.findings.filter((f) => f.kind === "affected").map((f) => f.advisory_id)).toContain("github-workflow-dispatch-204-to-200");
    expect(stored.repo.last_scan_sha).toBe(sha);

    const check = t.github.checkRuns[0]!;
    expect(stored.scan.check_run_id).toBe(String(check.id));
    expect(check).toMatchObject({ head_sha: sha, name: "SHAPI", status: "completed", conclusion: "neutral" });
    expect(check.output!.annotations.some((a) => a.path === "src/deploy.ts" && a.annotation_level === "warning")).toBe(true);
    // S-06: the retired model id in a constant no call uses is on the check too.
    expect(check.output!.summary).toContain("### Retired names in the code");
    expect(check.output!.summary).toContain("- `src/summaries.ts:3` model `claude-sonnet-4-5` (`anthropic-claude-sonnet-4-5-retirement`)");

    // a scan runs once
    expect((await runScanJob({ db, github: t.githubClients }, { scanId })).status).toBe("skipped");
  });

  it("a repository transferred to another account while its scan runs gets its findings under the new account", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    const other = await owner.insertInto("accounts").values({ github_installation_id: 5151, login: "newco", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
    // The transfer delivery is processed while the code downloads: it moves the repository and its history (see upsertRepository).
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/tarball/")) {
        await owner.updateTable("repositories").set({ account_id: other.id }).where("id", "=", repositoryId).execute();
        for (const table of ["scans", "findings", "fix_prs"] as const) await owner.updateTable(table).set({ account_id: other.id }).where("repository_id", "=", repositoryId).execute();
      }
      return t.fetch(input, init);
    }) as typeof globalThis.fetch;
    const github = githubClients({ appId: githubApp.appId, privateKey }, { fetch, resilient: false });
    expect((await runScanJob({ db, github }, { scanId })).status).toBe("succeeded");
    const rows = await withService(db, async (tx) => ({
      scan: await tx.selectFrom("scans").select("account_id").where("id", "=", scanId).executeTakeFirstOrThrow(),
      findings: await tx.selectFrom("findings").select("account_id").where("scan_id", "=", scanId).execute(),
    }));
    expect(rows.scan.account_id).toBe(other.id);
    expect(rows.findings.length).toBeGreaterThan(0);
    expect(new Set(rows.findings.map((f) => f.account_id))).toEqual(new Set([other.id]));
  });

  it("a first scan after install resolves the default branch head", async () => {
    const t = setup();
    const report = await runScanJob({ db, github: t.githubClients }, { repositoryId });
    expect(report.status).toBe("succeeded");
    const scan = await withService(db, (tx) => tx.selectFrom("scans").select("sha").where("id", "=", report.scanId!).executeTakeFirstOrThrow());
    expect(scan.sha).toBe(t.github.refs.get("main"));
  });

  it("records a failed scan on the check run instead of leaving it running", async () => {
    const t = setup();
    const scanId = await queueScan("does-not-exist");
    const report = await runScanJob({ db, github: t.githubClients }, { scanId });
    expect(report.status).toBe("failed");
    expect(t.github.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(t.github.checkRuns[0]!.output!.title).toBe("SHAPI could not scan this commit");
  });

  const running = (id: string, startedMinutesAgo: number, now = new Date()) =>
    sql`update scans set status = 'running', started_at = ${new Date(now.getTime() - startedMinutesAgo * 60_000)}, created_at = ${new Date(now.getTime() - (startedMinutesAgo + 1) * 60_000)} where id = ${id}`.execute(owner);
  const scanRow = (id: string) => owner.selectFrom("scans").select(["status", "error", "finished_at"]).where("id", "=", id).executeTakeFirstOrThrow();
  /** GitHub, except the code download never answers: it only ends when its request is aborted. */
  const hangingDownload = (t: ReturnType<typeof setup>) => {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes("/tarball/")) return t.fetch(input, init);
      // Like fetch: an aborted signal rejects at once, or as soon as it aborts.
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    return githubClients({ appId: githubApp.appId, privateKey }, { fetch, resilient: false });
  };

  it("a scan that hangs is stopped at its time limit and fails with the reason, on the dashboard and the check (I-02)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    const report = await runScanJob({ db, github: hangingDownload(t) }, { scanId }, { timeoutMs: 1000 });
    expect(report.status).toBe("failed");
    const row = await scanRow(scanId);
    expect(row).toMatchObject({ status: "failed", error: "SHAPI stopped this scan after 1 second: it took too long" });
    expect(row.finished_at).not.toBeNull();
    expect(t.github.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
  }, 30_000);

  it("a worker that shuts down mid-scan puts the scan back in the queue for its retry", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    const stop = new AbortController();
    const job = runScanJob({ db, github: hangingDownload(t) }, { scanId }, { signal: stop.signal });
    while ((await scanRow(scanId)).status !== "running") await new Promise((r) => setTimeout(r, 20));
    stop.abort(new Error("pg-boss shut down"));
    await expect(job).rejects.toThrow("pg-boss shut down");
    expect((await scanRow(scanId)).status).toBe("queued");
  }, 30_000);

  it("a retried job takes over the scan its dead worker left running; another job does not", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await running(scanId, 2);
    expect((await runScanJob({ db, github: t.githubClients }, { scanId })).status).toBe("skipped");
    expect((await runScanJob({ db, github: t.githubClients }, { scanId }, { retry: true })).status).toBe("succeeded");
  });

  it("the sweep fails a scan still running past its time limit, once, and leaves younger ones running (I-02)", async () => {
    const t = setup();
    const now = new Date();
    const hung = await queueScan(t.github.refs.get("main")!);
    const young = await queueScan("b".repeat(40));
    await running(hung, 21, now);
    await running(young, 15, now);
    expect(await stopHungScans(db, now)).toEqual([{ id: hung, repository_id: repositoryId }]);
    expect(await scanRow(hung)).toMatchObject({ status: "failed", error: "SHAPI stopped this scan: it was still running after 20 minutes" });
    expect((await scanRow(young)).status).toBe("running");
    // Not queued again: a scan that hangs every time cannot loop.
    expect(await staleQueuedScans(db, now)).not.toContain(hung);
    expect(await stopHungScans(db, now)).toEqual([]);
  });

  it("a scan job that failed every attempt marks its scan failed with the last error (dead letter, I-02)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await running(scanId, 3);
    const dead = { queue: QUEUES.repoScan, id: "j1", retries: 2, data: { scanId }, output: { name: "Error", message: "socket hang up" } };
    expect(await settleDeadJob(db, dead, QUEUES.repoScan)).toEqual({ attempts: 3, error: "socket hang up", scanFailed: scanId });
    expect(await scanRow(scanId)).toMatchObject({ status: "failed", error: "SHAPI gave up on this scan after 3 attempts: socket hang up" });
    // A finished scan stays as it is, and other queues' jobs only get reported.
    expect(await settleDeadJob(db, dead, QUEUES.repoScan)).toEqual({ attempts: 3, error: "socket hang up" });
    expect(await settleDeadJob(db, { ...dead, queue: QUEUES.repoFix, output: { value: "job expired" } }, QUEUES.repoScan)).toEqual({ attempts: 3, error: "job expired" });
  });

  it("allows one pending scan per commit, whoever inserts first", async () => {
    const repo = await owner.selectFrom("repositories").select(["id", "account_id"]).where("id", "=", repositoryId).executeTakeFirstOrThrow();
    const scan = { account_id: repo.account_id, repository_id: repo.id, sha: "c".repeat(40) };
    const [a, b] = await Promise.all([withService(db, (tx) => insertPendingScan(tx, scan)), withService(db, (tx) => insertPendingScan(tx, scan))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await expect(owner.insertInto("scans").values({ ...scan, status: "queued" }).execute()).rejects.toThrow(/scans_pending/);
    // a finished scan does not block the next one of the same commit
    await owner.updateTable("scans").set({ status: "succeeded" }).where("repository_id", "=", repo.id).execute();
    expect(await withService(db, (tx) => insertPendingScan(tx, scan))).toBeDefined();
  });
});

describe("cloud fix", () => {
  it("a fix job queued for an older scan fixes the repository's latest one, so its PR keeps newer commits", async () => {
    const t = setup();
    const older = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId: older });
    // main moves on, touching the file the fix changes; its scan's fix job was dropped by the queue (one waits per repository)
    const deploy = t.github.fileAt("main", "src/deploy.ts")!;
    const sha = t.github.pushAs("main", "src/deploy.ts", `${deploy}// a newer commit on main\n`);
    const newer = await queueScan(sha);
    await runScanJob({ db, github: t.githubClients }, { scanId: newer });

    const report = await runFixJob(t.fixDeps, { scanId: older });
    expect(report.scanId).toBe(newer);
    const pr = t.github.pulls.find((p) => p.head.ref === "shapi/github-workflow-dispatch-204-to-200")!;
    expect(t.github.fileAt(pr.head.ref, "src/deploy.ts")).toContain("// a newer commit on main");
    expect(t.github.fileAt(pr.head.ref, "src/deploy.ts")).toContain("![200, 204].includes(res.status)");
  }, 120_000);

  it("the latest scan is the newest queued, not the last to finish: a retried older scan does not replace a newer commit's fixes", async () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));
    const repo = await owner.selectFrom("repositories").select(["id", "account_id"]).where("id", "=", repositoryId).executeTakeFirstOrThrow();
    const scan = (sha: string, created: number, finished: number) =>
      owner
        .insertInto("scans")
        .values({ account_id: repo.account_id, repository_id: repo.id, sha, status: "succeeded", api_lock: JSON.stringify({}), created_at: at(created), finished_at: at(finished) })
        .returning("id")
        .executeTakeFirstOrThrow();
    // Push A, then push B; A's scan failed once and its retry finished after B's.
    await scan("a".repeat(40), 0, 30);
    const b = await scan("b".repeat(40), 5, 10);
    expect(await withService(db, (tx) => latestScanId(tx, repositoryId))).toBe(b.id);
  });

  it("repairs all three demo findings test-first; two PRs open now and the third waits for the hourly limit", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    const report = await runFixJob(t.fixDeps, { scanId });

    expect(report.repairs.find((r) => r.advisoryId === "github-workflow-dispatch-204-to-200")).toMatchObject({ status: "fixed" });
    // fixed from the advisory's fix alone, without recorded responses
    expect(report.repairs.find((r) => r.advisoryId === "quickbooks-minorversion-below-75-ignored")).toMatchObject({ status: "fixed" });
    // the HubSpot call site uses axios: its contract test replaces axios with a fake
    expect(report.repairs.find((r) => r.advisoryId === "hubspot-pipelines-v1-sunset")).toMatchObject({ status: "fixed" });
    expect(t.runs).toEqual(["acme/demo"]);
    // each advisory's repair is undone before the next one: no changed files and no contract tests (not even empty ones) are left
    expect(t.leftovers).toEqual([]);
    // at most 2 new PRs per hour, most urgent first: the critical GitHub fix, then one of the two high ones
    const refs = t.github.pulls.map((p) => p.head.ref);
    expect(refs).toHaveLength(2);
    expect(refs).toContain("shapi/github-workflow-dispatch-204-to-200");
    const [waiting] = ["quickbooks-minorversion-below-75-ignored", "hubspot-pipelines-v1-sunset"].filter((id) => !refs.includes(`shapi/${id}`));
    expect(waiting).toBeDefined();

    const pr = t.github.pulls.find((p) => p.head.ref === "shapi/github-workflow-dispatch-204-to-200")!;
    expect(pr).toMatchObject({ head: { ref: "shapi/github-workflow-dispatch-204-to-200" }, labels: [{ name: "shapi" }] });
    expect(pr.body).toContain("**Checked:** ✅ contract test (failed before, passes after)");
    // U-04: no cell has earned AUTO on the benchmark yet, so every fix opens as a draft for review.
    expect(pr.draft).toBe(true);
    expect(pr.body).toContain("· Tier: Review ·");
    expect(t.github.fileAt(pr.head.ref, "src/deploy.ts")).toContain("![200, 204].includes(res.status)");
    expect(t.github.fileAt(pr.head.ref, "test/shapi/github-workflow-dispatch-204-to-200.test.ts")).toBeTruthy();
    expect(t.github.commits.get(t.github.refs.get(pr.head.ref)!)!.message).toContain("verified in");

    const dashboard = t.github.issues[0]!;
    expect(dashboard.body).toContain("## Waiting");
    expect(dashboard.body).toContain(`<!-- shapi:create:${waiting} -->`);
    expect(dashboard.body).not.toContain("## Needs a manual fix");
    expect(dashboard.body).toContain(`[#${pr.number}]`);

    // a rerun of the same fix job changes nothing on GitHub
    const before = t.github.calls.filter((c) => c.method !== "GET").length;
    const again = await runFixJob(t.fixDeps, { scanId });
    expect(again.delivery!.outcomes.find((o) => o.advisoryId === "github-workflow-dispatch-204-to-200")!.action).toBe("unchanged");
    const writes = t.github.calls.filter((c) => c.method !== "GET").slice(before).filter((c) => !c.path.endsWith("/access_tokens"));
    expect(writes).toEqual([]);
  }, 120_000);

  it("opens no PR in a cell whose fix PRs this account closed unmerged three times, and lists the fix as manual (U-04)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    // Three other repositories closed the GitHub status-code fix without merging it.
    const { account_id } = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    for (const n of [1, 2, 3]) {
      const other = await owner.insertInto("repositories").values({ account_id, github_repo_id: REPO_ID + 100 + n, full_name: `acme/other${n}`, default_branch: "main", private: true }).returning("id").executeTakeFirstOrThrow();
      await owner
        .insertInto("fix_prs")
        .values({ account_id, repository_id: other.id, advisory_id: "github-workflow-dispatch-204-to-200", branch: "shapi/github-workflow-dispatch-204-to-200", state: "closed", closed_at: new Date(), updated_at: new Date() })
        .execute();
    }
    const report = await runFixJob(t.fixDeps, { scanId });
    expect(report.repairs.find((r) => r.advisoryId === "github-workflow-dispatch-204-to-200")).toEqual({
      advisoryId: "github-workflow-dispatch-204-to-200",
      status: "alert",
      reason: "fix tier ALERT: 3 fix PRs closed without merging, 0 merged",
    });
    expect(t.github.pulls.map((p) => p.head.ref)).not.toContain("shapi/github-workflow-dispatch-204-to-200");
    expect(t.github.issues[0]!.body).toContain("## Needs a manual fix");
  }, 120_000);

  it("lists every inspected call site SHAPI left alone under Not changed, with its reason: exposed plus possible (D-02)", async () => {
    // A second dispatch call that never reads the status: exposed to the change, not affected by it.
    const t = setup({
      "src/redeploy.ts": [
        'const API = "https://api.github.com";',
        "export async function redeploy(owner: string, repo: string, token: string): Promise<void> {",
        "  await fetch(`${API}/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`, {",
        '    method: "POST",',
        '    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },',
        '    body: JSON.stringify({ ref: "main" }),',
        "  });",
        "}",
        "",
      ].join("\n"),
    });
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    await runFixJob(t.fixDeps, { scanId });

    const scan = await withService(db, (tx) => tx.selectFrom("scans").select("api_lock").where("id", "=", scanId).executeTakeFirstOrThrow());
    const match = matchAdvisories(storedLock(scan.api_lock), (await reviewedAdvisories(db)).map((a) => a.advisory), { now: new Date() });
    const inspectedFor = (advisoryId: string) => [...match.exposed, ...match.possible].filter((f) => f.advisory.id === advisoryId);
    expect(inspectedFor("github-workflow-dispatch-204-to-200").map((f) => f.callSite.file)).toContain("src/redeploy.ts");
    expect(t.github.pulls.length).toBeGreaterThan(0);
    for (const pr of t.github.pulls) {
      const inspected = inspectedFor(pr.head.ref.replace("shapi/", ""));
      const section = /<summary>Not changed \((\d+)\)<\/summary>\n\n([\s\S]*?)\n\n<\/details>/.exec(pr.body ?? "");
      expect(Number(section?.[1])).toBe(inspected.length);
      const listed = section![2]!.split("\n").filter((l) => l.startsWith("- "));
      expect(listed).toHaveLength(inspected.length);
      for (const f of inspected) expect(listed.some((l) => l.includes(`${f.callSite.file}:${f.callSite.line}`) && l.includes(f.reasons[0]!.slice(0, 30)))).toBe(true);
    }
  }, 120_000);

  it("builds each fix PR on the scanned commit, so a push to main while the fix job waited is not reverted", async () => {
    const t = setup();
    const scanned = t.github.refs.get("main")!;
    const scanId = await queueScan(scanned);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    const upstream = `// edited upstream after the scan\n${t.github.fileAt("main", "src/deploy.ts")}`;
    t.github.pushAs("main", "src/deploy.ts", upstream);
    await runFixJob(t.fixDeps, { scanId });
    const pr = t.github.pulls.find((p) => p.head.ref === "shapi/github-workflow-dispatch-204-to-200")!;
    expect(t.github.commits.get(t.github.refs.get(pr.head.ref)!)!.parents).toEqual([scanned]);
    expect(t.github.fileAt("main", "src/deploy.ts")).toBe(upstream);
  }, 120_000);

  it("delivers the fixes verified before the sandbox ran out of time, and reports the rest as not attempted", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    // The sandbox reaches its lifetime limit when the second advisory's first contract test is about to run.
    let first: string | undefined;
    const workspace: WorkspaceRunner = (files, labels, fn) =>
      t.workspace(files, labels, (ws) =>
        fn({
          ...ws,
          async runTest(file) {
            const advisory = /^test\/shapi\/([^.]+)/.exec(file)?.[1];
            first ??= advisory;
            if (advisory !== first) throw new SandboxLifetimeError("the sandbox reached its 60-minute lifetime limit: the job needs more time than one sandbox allows");
            return ws.runTest(file);
          },
        }),
      );
    const report = await runFixJob({ ...t.fixDeps, workspace, engine: "build-1" }, { scanId });
    expect(report.repairs[0]).toMatchObject({ advisoryId: first, status: "fixed" });
    const rest = report.repairs.slice(1);
    expect(rest.length).toBeGreaterThan(0);
    for (const r of rest) expect(r).toMatchObject({ status: "not-attempted", reason: expect.stringContaining("lifetime limit") });
    expect(t.github.pulls.map((p) => p.head.ref)).toEqual([`shapi/${first}`]);
    // Not a finished run: the next build tries the rest again.
    const row = await withService(db, (tx) => tx.selectFrom("scans").select("fix_engine").where("id", "=", scanId).executeTakeFirstOrThrow());
    expect(row.fix_engine).toBeNull();
  }, 120_000);

  it("never sends code to an LLM unless the account turned LLM fixes on", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    const asked: string[] = [];
    const llm = { fix: async (req: { advisory: { id: string } }) => (asked.push(req.advisory.id), { status: "declined" as const, reason: "test" }) };
    await runFixJob({ ...t.fixDeps, llm: llm as never }, { scanId });
    expect(asked).toEqual([]);
  }, 120_000);
});

describe("fixes after an upgrade", () => {
  it("a new build runs the fix job again where a fixable finding has no PR yet; the same build does not", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    // No fix job has run on this scan (or an older build's could not fix it): due on this build.
    expect(await scansToRefix(db, "build-2")).toEqual([{ scanId, repositoryId }]);
    await runFixJob({ ...t.fixDeps, engine: "build-2" }, { scanId });
    expect(await scansToRefix(db, "build-2")).toEqual([]);
    // Two PRs opened; the third fix waits for the hourly limit, so the next build tries it again.
    expect(t.github.pulls).toHaveLength(2);
    expect(await scansToRefix(db, "build-3")).toEqual([{ scanId, repositoryId }]);

    // Once every fixable finding has a PR (a closed one included), new builds leave the repository alone.
    const account = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    const affected = await owner.selectFrom("findings").select("advisory_id").distinct().where("scan_id", "=", scanId).where("kind", "=", "affected").execute();
    const withPr = new Set((await owner.selectFrom("fix_prs").select("advisory_id").where("repository_id", "=", repositoryId).execute()).map((p) => p.advisory_id));
    for (const f of affected.filter((f) => !withPr.has(f.advisory_id))) {
      await owner.insertInto("fix_prs").values({ account_id: account.account_id, repository_id: repositoryId, advisory_id: f.advisory_id, branch: `shapi/${f.advisory_id}`, state: "closed", updated_at: new Date() }).execute();
    }
    expect(await scansToRefix(db, "build-4")).toEqual([]);
  }, 120_000);

  it("skips repositories the plan does not cover, which would only get a failed scan on every deploy", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    expect(await scansToRefix(db, "build-6", { billingEnforced: true })).toEqual([{ scanId, repositoryId }]);
    // Another private repository brings four committers: more than the free plan covers.
    const account = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    await owner.insertInto("repositories").values({ account_id: account.account_id, github_repo_id: 778, full_name: "acme/older", default_branch: "main", private: true, created_at: new Date("2020-01-01"), committers: JSON.stringify(["a", "b", "c", "d"]) }).execute();
    expect(await scansToRefix(db, "build-6", { billingEnforced: true })).toEqual([]);
    expect(await scansToRefix(db, "build-6")).toEqual([{ scanId, repositoryId }]);
  }, 120_000);

  it("never opens a pull request for an unverified advisory, even one its recipe can fix (C-03)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    await owner.deleteFrom("findings").where("scan_id", "=", scanId).where("advisory_id", "!=", "github-workflow-dispatch-204-to-200").execute();
    await owner.updateTable("findings").set({ advisory_id: "github-dispatch-unverified" }).where("scan_id", "=", scanId).execute();
    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    await upsertAdvisories(db, [{ ...base, id: "github-dispatch-unverified", status: "unverified" }], { reviewed: true, source: "repo" });
    try {
      const report = await runFixJob(t.fixDeps, { scanId });
      expect(report.repairs).toEqual([{ advisoryId: "github-dispatch-unverified", status: "unverified", reason: "the advisory is not verified yet" }]);
      expect(t.runs).toEqual([]);
      expect(t.github.pulls).toEqual([]);
    } finally {
      await owner.deleteFrom("advisories").where("id", "=", "github-dispatch-unverified").execute();
    }
  }, 120_000);

  it("leaves findings no recipe can fix alone unless the account opted in to Claude and the worker has a key", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    const account = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    // Strip the recipes: what is left needs Claude.
    await owner.updateTable("findings").set({ advisory_id: "github-dispatch-without-recipe" }).where("scan_id", "=", scanId).execute();
    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    await upsertAdvisories(db, [{ ...base, id: "github-dispatch-without-recipe", recipeId: undefined, fix: undefined }], { reviewed: true, source: "repo" });
    try {
      expect(await scansToRefix(db, "build-5")).toEqual([]);
      expect(await scansToRefix(db, "build-5", { llm: true })).toEqual([]);
      await owner.updateTable("accounts").set({ settings: JSON.stringify({ llmFixes: true }) }).where("id", "=", account.account_id).execute();
      expect(await scansToRefix(db, "build-5")).toEqual([]);
      expect(await scansToRefix(db, "build-5", { llm: true })).toEqual([{ scanId, repositoryId }]);
    } finally {
      await owner.deleteFrom("advisories").where("id", "=", "github-dispatch-without-recipe").execute();
    }
  }, 120_000);
});

describe("LLM budget", () => {
  it("is kept per fix job: its retries cannot spend it again, and another job on the same scan has its own", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    const account = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    await owner.updateTable("accounts").set({ settings: JSON.stringify({ llmFixes: true }) }).where("id", "=", account.account_id).execute();
    // Only the GitHub finding, and without its recipe: Claude is asked.
    await owner.deleteFrom("findings").where("scan_id", "=", scanId).where("advisory_id", "!=", "github-workflow-dispatch-204-to-200").execute();
    await owner.updateTable("findings").set({ advisory_id: "github-dispatch-llm-only" }).where("scan_id", "=", scanId).execute();
    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    await upsertAdvisories(db, [{ ...base, id: "github-dispatch-llm-only", recipeId: undefined }], { reviewed: true, source: "repo" });
    const asked: string[] = [];
    const llm = { fix: async (req: { advisory: { id: string } }) => (asked.push(req.advisory.id), { status: "declined" as const, reason: "test" }) };
    process.env.SHAPI_LLM_CALLS_PER_JOB = "1";
    try {
      await runFixJob({ ...t.fixDeps, llm: llm as never }, { scanId, jobId: "job-1" });
      expect(asked).toEqual(["github-dispatch-llm-only"]);
      // pg-boss runs the same job again (a retry, or after expiry): it keeps its id, and its one call is spent.
      await runFixJob({ ...t.fixDeps, llm: llm as never }, { scanId, jobId: "job-1" });
      expect(asked).toHaveLength(1);
      // A new job on the same scan (a dashboard tick, lifting a pause, the advisory fan-out) gets its own budget.
      await runFixJob({ ...t.fixDeps, llm: llm as never }, { scanId, jobId: "job-2" });
      expect(asked).toHaveLength(2);
      expect(await owner.selectFrom("fix_job_llm_calls").select(["job_id", "calls"]).orderBy("job_id").execute()).toEqual([
        { job_id: "job-1", calls: 2 },
        { job_id: "job-2", calls: 1 },
      ]);
    } finally {
      delete process.env.SHAPI_LLM_CALLS_PER_JOB;
      await owner.deleteFrom("advisories").where("id", "=", "github-dispatch-llm-only").execute();
    }
  }, 120_000);
});

describe("advisory fan-out", () => {
  it("re-matches stored api.locks when an advisory is added, without downloading code again", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    expect((await runAdvisoryFanout(db)).rematched).toBe(0);

    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    const added = { ...base, id: "github-dispatch-copy-for-test", title: "A new advisory on the same endpoint" };
    await upsertAdvisories(db, [added], { reviewed: true, source: "repo" });
    const tarballsBefore = t.github.calls.filter((c) => c.path.includes("/tarball/")).length;

    const report = await runAdvisoryFanout(db);
    expect(report).toMatchObject({ rematched: 1, fixScans: [{ scanId, repositoryId }] });
    expect(t.github.calls.filter((c) => c.path.includes("/tarball/")).length).toBe(tarballsBefore);
    const findings = await withService(db, (tx) => tx.selectFrom("findings").select("advisory_id").where("scan_id", "=", scanId).where("advisory_id", "=", added.id).execute());
    expect(findings.length).toBeGreaterThan(0);
    expect((await runAdvisoryFanout(db)).rematched).toBe(0);
    await owner.deleteFrom("advisories").where("id", "=", added.id).execute();
  });

  it("saves a re-match under the account the repository is in now, when it moved during the fan-out", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId });
    // A second repository with the same code, re-matched after the first.
    const first = await owner.selectFrom("scans").selectAll().where("id", "=", scanId).executeTakeFirstOrThrow();
    const second = await owner.insertInto("repositories").values({ account_id: first.account_id, github_repo_id: REPO_ID + 1, full_name: "acme/demo2", default_branch: "main", private: true }).returning("id").executeTakeFirstOrThrow();
    await owner
      .insertInto("scans")
      .values({ account_id: first.account_id, repository_id: second.id, sha: first.sha, status: "succeeded", api_lock: JSON.stringify(first.api_lock), advisories: JSON.stringify(first.advisories), finished_at: new Date() })
      .execute();
    const newOwner = await owner.insertInto("accounts").values({ github_installation_id: INSTALLATION + 1, login: "new-owner", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();

    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    const added = { ...base, id: "github-dispatch-copy-for-move", title: "A new advisory on the same endpoint" };
    await upsertAdvisories(db, [added], { reviewed: true, source: "repo" });
    const notices: { accountId: string; repositoryId: string }[] = [];
    try {
      // While the fan-out works on the first repository, the second is transferred (as upsertRepository does).
      const report = await runAdvisoryFanout(db, {
        notify: async (n) => {
          notices.push({ accountId: n.accountId, repositoryId: n.repositoryId });
          if (n.repositoryId !== repositoryId) return;
          await owner.updateTable("repositories").set({ account_id: newOwner.id }).where("id", "=", second.id).execute();
          for (const table of ["scans", "findings", "fix_prs"] as const) await owner.updateTable(table).set({ account_id: newOwner.id }).where("repository_id", "=", second.id).execute();
        },
      });
      expect(report.rematched).toBe(2);
      const owners = await owner.selectFrom("findings").select("account_id").distinct().where("repository_id", "=", second.id).execute();
      expect(owners).toEqual([{ account_id: newOwner.id }]);
      expect(notices).toEqual([
        { accountId: first.account_id, repositoryId },
        { accountId: newOwner.id, repositoryId: second.id },
      ]);
    } finally {
      await owner.deleteFrom("advisories").where("id", "=", added.id).execute();
    }
  });
});

describe("triggers", () => {
  const deliver = async (event: string, payload: object) => {
    const id = randomUUID();
    await db.insertInto("webhook_deliveries").values({ delivery_id: id, event, action: (payload as { action?: string }).action ?? null, installation_id: INSTALLATION, payload: JSON.stringify(payload) }).execute();
    return id;
  };

  it("a new installation asks for a first scan of each new repository; a default-branch push asks for that commit", async () => {
    await owner.deleteFrom("accounts").execute();
    const t = setup();
    const installed = await processDelivery({ db, github: t.githubClients }, await deliver("installation", { action: "created", installation: { id: INSTALLATION, account: { login: "acme", type: "Organization" } } }));
    const repo = await withService(db, (tx) => tx.selectFrom("repositories").select("id").executeTakeFirstOrThrow());
    expect(installed.scans).toEqual([{ repositoryId: repo.id }]);

    const again = await processDelivery({ db, github: t.githubClients }, await deliver("installation_repositories", { action: "added", installation: { id: INSTALLATION } }));
    expect(again.scans).toEqual([]);

    const pushed = await processDelivery(
      { db, github: t.githubClients },
      await deliver("push", { ref: "refs/heads/main", after: "a".repeat(40), installation: { id: INSTALLATION }, repository: { id: REPO_ID, full_name: "acme/demo", default_branch: "main", private: true } }),
    );
    expect(pushed.scans).toHaveLength(1);
    expect(pushed.scans[0]).toHaveProperty("scanId");
  });

  it("after an upgrade the worker scans the repository again, so the fix job uses this build's api.lock", async () => {
    const t = setup();
    // A scan mapped by an older build, whose fix job never opened PRs.
    const oldScan = await queueScan(t.github.refs.get("main")!);
    await runScanJob({ db, github: t.githubClients }, { scanId: oldScan });
    await owner.updateTable("scans").set({ fix_engine: "old-build" }).where("id", "=", oldScan).execute();
    const logs: { msg: string; obj: object }[] = [];
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "", SHAPI_ADVISORIES: ADVISORIES, WEBHOOK_SWEEP_CRON: "", WEBHOOK_RETENTION_DAYS: 14, SHAPI_RECORDINGS: RECORDINGS, FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "", SHAPI_PUBLIC_URL: "https://shapi.test", GIT_SHA: "new-build", githubApp },
      env: { SHAPI_SHAPE_SECRET: "test" },
      log: { info: (o, m) => logs.push({ msg: m ?? "", obj: o }), error: (o, m) => logs.push({ msg: `ERROR ${m} ${String((o as { err?: unknown }).err)}`, obj: o }) },
      fetch: t.fetch,
      githubOptions: { resilient: false },
      workspace: t.workspace,
    });
    try {
      const deadline = Date.now() + 90_000;
      while (!logs.some((l) => l.msg === "fix job finished") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(logs.filter((l) => l.msg.startsWith("ERROR")).map((l) => l.msg)).toEqual([]);
      expect(logs.find((l) => l.msg === "repositories scanned again for this build")?.obj).toMatchObject({ engine: "new-build", scans: 1 });
      const scans = await owner.selectFrom("scans").select(["id", "fix_engine"]).where("repository_id", "=", repositoryId).orderBy("created_at").execute();
      // the fix job ran on the new scan, not on the old one
      expect(scans).toEqual([{ id: oldScan, fix_engine: "old-build" }, { id: expect.any(String), fix_engine: "new-build" }]);
      expect((logs.find((l) => l.msg === "fix job finished")!.obj as { scanId: string }).scanId).toBe(scans[1]!.id);
      expect(t.github.pulls).toHaveLength(2);
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 150_000);

  it("every queue has a time limit and a dead-letter queue (I-02)", () => {
    expect(QUEUE_OPTIONS[0]![0]).toBe(QUEUES.deadLetter);
    for (const [name, options] of QUEUE_OPTIONS.slice(1)) {
      expect(options, name).toMatchObject({ deadLetter: QUEUES.deadLetter, expireInSeconds: expect.any(Number) });
    }
    expect(QUEUE_OPTIONS.map(([name]) => name).sort()).toEqual(Object.values(QUEUES).sort());
  });

  it("the worker dead-letters a job that failed every attempt: its scan shows failed, and the error is logged for Sentry (I-02)", async () => {
    const t = setup();
    const scanId = await queueScan(t.github.refs.get("main")!);
    const scanRow = (id: string) => owner.selectFrom("scans").select(["status", "error"]).where("id", "=", id).executeTakeFirstOrThrow();
    const errors: string[] = [];
    // No GitHub App configured: every scan job throws.
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "", SHAPI_ADVISORIES: ADVISORIES, WEBHOOK_SWEEP_CRON: "", WEBHOOK_RETENTION_DAYS: 14, SHAPI_RECORDINGS: RECORDINGS, FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "", SHAPI_PUBLIC_URL: "https://shapi.test", GIT_SHA: "test" },
      env: { SHAPI_SHAPE_SECRET: "test" },
      log: { info: () => undefined, error: (o, m) => errors.push(`${m} ${String((o as { err?: unknown }).err)}`) },
      fetch: t.fetch,
    });
    try {
      await boss.send(QUEUES.repoScan, { scanId }, { retryLimit: 0 });
      const deadline = Date.now() + 60_000;
      while ((await scanRow(scanId)).status !== "failed" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect((await scanRow(scanId)).error).toBe("SHAPI gave up on this scan after 1 attempt: GitHub App is not configured");
      expect(errors).toContain("job dead-lettered Error: repo-scan job failed after 1 attempts: GitHub App is not configured");
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 90_000);

  it("the worker runs push -> scan -> fix -> PR end to end", async () => {
    const t = setup();
    const logs: string[] = [];
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "", SHAPI_ADVISORIES: ADVISORIES, WEBHOOK_SWEEP_CRON: "", WEBHOOK_RETENTION_DAYS: 14, SHAPI_RECORDINGS: RECORDINGS, FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "", SHAPI_PUBLIC_URL: "https://shapi.test", GIT_SHA: "test", githubApp },
      env: { SHAPI_SHAPE_SECRET: "test" },
      log: { info: (_o, m) => logs.push(m ?? ""), error: (o, m) => logs.push(`ERROR ${m} ${String((o as { err?: unknown }).err)}`) },
      fetch: t.fetch,
      githubOptions: { resilient: false },
      workspace: t.workspace,
    });
    try {
      const sha = t.github.refs.get("main")!;
      const id = await deliver("push", { ref: "refs/heads/main", after: sha, installation: { id: INSTALLATION }, repository: { id: REPO_ID, full_name: "acme/demo", default_branch: "main", private: true } });
      await boss.send(QUEUES.githubWebhook, { deliveryId: id });
      const deadline = Date.now() + 90_000;
      while (!logs.includes("fix job finished") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(logs.filter((l) => l.startsWith("ERROR"))).toEqual([]);
      expect(logs).toEqual(expect.arrayContaining(["webhook processed", "scan finished", "fix job finished"]));
      expect(t.github.pulls.map((p) => p.head.ref).sort()).toEqual(["shapi/github-workflow-dispatch-204-to-200", "shapi/quickbooks-minorversion-below-75-ignored"]);
      // V-03: the GitHub 204→200 contract test is stubbed from the recorded witnesses, and its PR says so; the
      // QuickBooks one is built from the advisory's fix.
      const [witness204, witness200] = [0, 2].map((i) => JSON.parse(readFileSync(path.join(root, "fixtures", "witnesses", "github-workflow-dispatch-204-to-200.json"), "utf8"))[i].shapeId as string);
      const github = t.github.pulls.find((p) => p.head.ref === "shapi/github-workflow-dispatch-204-to-200")!;
      expect(github.body).toContain(`**Stub:** from recorded responses (recording github-workflow-dispatch-204-to-200.json, witnesses \`${witness204!.slice(0, 12)}\` → \`${witness200!.slice(0, 12)}\`).`);
      const quickbooks = t.github.pulls.find((p) => p.head.ref === "shapi/quickbooks-minorversion-below-75-ignored")!;
      expect(quickbooks.body).toContain("**Stub:** synthesized from the advisory (no recorded responses for this endpoint).");
      expect(t.github.checkRuns[0]).toMatchObject({ head_sha: sha, status: "completed" });
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 150_000);
});

describe("slack alerts", () => {
  const notices: FindingsNotice[] = [];
  const notify = async (n: FindingsNotice) => void notices.push(n);

  it("alerts once per new affected call site: the first scan, not a rescan with the same findings", async () => {
    const t = setup();
    notices.length = 0;
    const sha = t.github.refs.get("main")!;
    await runScanJob({ db, github: t.githubClients, notify }, { scanId: await queueScan(sha) });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ repositoryId, sha, reason: "push" });
    expect(notices[0]!.findings.map((f) => f.advisory.id).sort()).toEqual(["github-workflow-dispatch-204-to-200", "hubspot-pipelines-v1-sunset", "quickbooks-minorversion-below-75-ignored"]);

    await runScanJob({ db, github: t.githubClients, notify }, { scanId: await queueScan(sha) });
    expect(notices).toHaveLength(1);
  });

  it("alerts when a new advisory hits code that was already scanned", async () => {
    const t = setup();
    await runScanJob({ db, github: t.githubClients }, { scanId: await queueScan(t.github.refs.get("main")!) });
    notices.length = 0;
    const base = loadAdvisories(ADVISORIES).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    await upsertAdvisories(db, [{ ...base, id: "github-dispatch-copy-for-slack", title: "Another change on the same endpoint" }], { reviewed: true, source: "repo" });
    await runAdvisoryFanout(db, { notify });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ reason: "advisory", repositoryId });
    expect(notices[0]!.findings.map((f) => f.advisory.id)).toEqual(["github-dispatch-copy-for-slack"]);
  });

  it("posts to the account's Slack incoming webhook only, and never throws", async () => {
    const t = setup();
    await runScanJob({ db, github: t.githubClients }, { scanId: await queueScan(t.github.refs.get("main")!) });
    const hook = "https://hooks.slack.com/services/T000/B000/xyz";
    const posted: { url: string; body: { text: string; blocks: { text?: { text: string } }[] } }[] = [];
    let fail = false;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return fail ? new Response("invalid_token", { status: 403 }) : new Response("ok");
    }) as typeof globalThis.fetch;
    const errors: string[] = [];
    const notifier = slackNotifier({ db, fetch, publicUrl: "https://shapi.test", advisoriesRepo: "SriVarshini09/shapi-advisories", log: { info: () => {}, error: (o, m) => void errors.push(`${m}: ${String((o as { err?: unknown }).err)}`) }, now: () => new Date("2026-10-23") });
    const account = await withService(db, (tx) => tx.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow());
    const setHook = (url: string | undefined) =>
      withService(db, (tx) => tx.updateTable("accounts").set({ settings: JSON.stringify(url ? { slackWebhookUrl: url } : {}) }).where("id", "=", account.account_id).execute());
    const findings = await withService(db, (tx) => tx.selectFrom("findings").select(["advisory_id", "call_site", "reasons"]).where("kind", "=", "affected").where("repository_id", "=", repositoryId).where("advisory_id", "=", "github-workflow-dispatch-204-to-200").limit(1).execute());
    const advisory = loadAdvisories(ADVISORIES).find((a) => a.id === findings[0]!.advisory_id)!;
    const notice: FindingsNotice = { accountId: account.account_id, repositoryId, sha: "a".repeat(40), reason: "push", findings: [{ advisory, callSite: findings[0]!.call_site as never, reasons: [] }] };

    await setHook(undefined);
    await notifier(notice);
    await setHook("http://169.254.169.254/latest");
    await notifier(notice);
    expect(posted).toEqual([]);

    await setHook(hook);
    await notifier(notice);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe(hook);
    expect(posted[0]!.body.text).toBe("SHAPI: 1 new affected call site in acme/demo");
    expect(posted[0]!.body.blocks[1]!.text!.text).toContain(`<https://github.com/acme/demo/blob/${"a".repeat(40)}/`);
    expect(posted[0]!.body.blocks[1]!.text!.text).toContain(`*${advisory.severity.toUpperCase()}* <https://github.com/SriVarshini09/shapi-advisories/blob/HEAD/advisories/${advisory.id}.json|`);

    fail = true;
    await expect(notifier(notice)).resolves.toBeUndefined();
    expect(errors).toEqual(["slack alert failed: Error: Slack answered 403: invalid_token"]);
    await setHook(undefined);
  });
});

describe("slack message", () => {
  it("lists the most severe first, links each line, shows deadlines, and counts what it leaves out", () => {
    const base = loadAdvisories(ADVISORIES);
    const site = (file: string, line: number) => ({ file, line, column: 1, provider: "x", kind: "http" as const, client: "fetch", method: "GET" as const, host: null, endpoint: "/", resolved: true, id: "000000000000", surface: { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] } });
    const hubspot = base.find((a) => a.id === "hubspot-pipelines-v1-sunset")!;
    const github = base.find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    const findings = [
      { advisory: hubspot, callSite: site("src/crm.ts", 6), reasons: [] },
      { advisory: github, callSite: site("src/deploy.ts", 13), reasons: [] },
      ...Array.from({ length: 10 }, (_, i) => ({ advisory: hubspot, callSite: site(`src/more${i}.ts`, 1), reasons: [] })),
    ];
    const msg = slackMessage({ accountId: "7", repositoryId: "1", sha: "abc1234def", reason: "push", findings, repository: "acme/demo", publicUrl: "https://shapi.test/", now: new Date("2026-10-23T00:00:00Z") }) as { text: string; blocks: { text?: { text: string }; elements?: { text: string }[] }[] };
    expect(msg.text).toBe("SHAPI: 12 new affected call sites in acme/demo");
    expect(msg.blocks[0]!.text!.text).toBe("*SHAPI:* 12 new affected call sites in <https://github.com/acme/demo|acme/demo>, after the push of `abc1234`.");
    const lines = msg.blocks[1]!.text!.text.split("\n");
    expect(lines[0]).toBe("• *CRITICAL* workflow_dispatch returns 200 with a body instead of 204");
    expect(lines[1]).toBe("   <https://github.com/acme/demo/blob/abc1234def/src/deploy.ts#L13|src/deploy.ts:13>");
    expect(lines[3]).toBe("   <https://github.com/acme/demo/blob/abc1234def/src/crm.ts#L6|src/crm.ts:6> · deadline 2026-12-04 (in 42 days)");
    expect(lines.at(-1)).toBe("…and 2 more.");
    expect(msg.blocks[2]!.elements![0]!.text).toContain("<https://shapi.test/a/7|Open in SHAPI>");
  });

  it("keeps every section under Slack's 3000 characters, counting what does not fit, and encodes file paths in links", () => {
    const base = loadAdvisories(ADVISORIES);
    const site = (file: string, line: number) => ({ file, line, column: 1, provider: "x", kind: "http" as const, client: "fetch", method: "GET" as const, host: null, endpoint: "/", resolved: true, id: "000000000000", surface: { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] } });
    const findings = Array.from({ length: 10 }, (_, i) => ({ advisory: base[i % base.length]!, callSite: site(`src/integrations/github/workflows-${i}.ts`, 100 + i), reasons: [] }));
    const msg = slackMessage({ accountId: "7", repositoryId: "1", sha: "f".repeat(40), reason: "push", findings, repository: "acme-corp/payments-service", publicUrl: "https://shapi.test", advisoriesRepo: "SriVarshini09/shapi-advisories", now: new Date("2026-10-23T00:00:00Z") }) as { blocks: { text?: { text: string } }[] };
    for (const b of msg.blocks) expect(b.text?.text.length ?? 0).toBeLessThanOrEqual(3000);
    const lines = msg.blocks[1]!.text!.text.split("\n");
    const listed = lines.filter((l) => l.startsWith("• ")).length;
    expect(listed).toBeLessThan(10);
    expect(lines.at(-1)).toBe(`…and ${10 - listed} more.`);

    const odd = slackMessage({ accountId: "7", repositoryId: "1", sha: "abc", reason: "push", findings: [{ advisory: base[0]!, callSite: site("src/a b#|>.ts", 3), reasons: [] }], repository: "acme/demo", publicUrl: "https://shapi.test", now: new Date("2026-10-23T00:00:00Z") }) as { blocks: { text?: { text: string } }[] };
    expect(odd.blocks[1]!.text!.text).toContain("<https://github.com/acme/demo/blob/abc/src/a%20b%23%7C%3E.ts#L3|src/a b#|&gt;.ts:3>");
  });
});
