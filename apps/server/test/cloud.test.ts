import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateToLatest, upsertAdvisories, withService, type Db } from "@shapi/db";
import { loadAdvisories } from "@shapi/core";
import { localWorkspace } from "@shapi/repair";
import { fakeRepoGitHub } from "../../../test-utils/fake-github";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import {
  QUEUES,
  githubClients,
  processDelivery,
  runAdvisoryFanout,
  runFixJob,
  runScanJob,
  startWorker,
  syncAdvisoriesJob,
  type WorkspaceRunner,
} from "../src/index";

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

function setup() {
  const fake = fakeRepoGitHub("acme/demo", demoFiles(), { repoId: REPO_ID });
  const github = githubClients({ appId: githubApp.appId, privateKey }, { fetch: fake.fetch, resilient: false });
  /** Fixes are verified in a local copy here; production runs the same steps in an E2B sandbox. */
  const runs: string[] = [];
  const workspace: WorkspaceRunner = async (files, labels, fn) => {
    runs.push(labels.repository!);
    const dir = mkdtempSync(path.join(tmp, "ws-"));
    for (const f of files) {
      mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      writeFileSync(path.join(dir, f.path), f.content);
    }
    return fn(localWorkspace(dir));
  };
  return { ...fake, githubClients: github, workspace, runs, fixDeps: { db, github, workspace, recordingsDir: RECORDINGS, shapeSecret: "test" } };
}

async function queueScan(sha: string) {
  const scan = await withService(db, async (tx) => {
    const repo = await tx.selectFrom("repositories").select(["id", "account_id"]).where("id", "=", repositoryId).executeTakeFirstOrThrow();
    return tx.insertInto("scans").values({ account_id: repo.account_id, repository_id: repo.id, sha, status: "queued" }).returning("id").executeTakeFirstOrThrow();
  });
  return scan.id;
}

describe("cloud scan", () => {
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

    // a scan runs once
    expect((await runScanJob({ db, github: t.githubClients }, { scanId })).status).toBe("skipped");
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
});

describe("cloud fix", () => {
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
    // at most 2 new PRs per hour, most urgent first: the critical GitHub fix, then one of the two high ones
    const refs = t.github.pulls.map((p) => p.head.ref);
    expect(refs).toHaveLength(2);
    expect(refs).toContain("shapi/github-workflow-dispatch-204-to-200");
    const [waiting] = ["quickbooks-minorversion-below-75-ignored", "hubspot-pipelines-v1-sunset"].filter((id) => !refs.includes(`shapi/${id}`));
    expect(waiting).toBeDefined();

    const pr = t.github.pulls.find((p) => p.head.ref === "shapi/github-workflow-dispatch-204-to-200")!;
    expect(pr).toMatchObject({ head: { ref: "shapi/github-workflow-dispatch-204-to-200" }, labels: [{ name: "shapi" }] });
    expect(pr.body).toContain("### Contract test");
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

  it("the worker runs push -> scan -> fix -> PR end to end", async () => {
    const t = setup();
    const logs: string[] = [];
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "", SHAPI_ADVISORIES: ADVISORIES, WEBHOOK_SWEEP_CRON: "", WEBHOOK_RETENTION_DAYS: 14, SHAPI_RECORDINGS: RECORDINGS, FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "", githubApp },
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
      expect(t.github.checkRuns[0]).toMatchObject({ head_sha: sha, status: "completed" });
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 150_000);
});
