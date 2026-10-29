import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgShapeStore, createDb, listAdvisories, migrateToLatest, type Db } from "@shapi/db";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { QUEUES, buildApp, loadConfig, runCanaryJob, startWorker, syncAdvisoriesJob } from "../src/index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADVISORIES = path.join(root, "advisories");
let pg: TestPostgres;
let db: Db;

beforeAll(async () => {
  pg = await startTestPostgres();
  const owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  await owner.destroy();
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);

const testConfig = { LOG_LEVEL: "info" as const, GIT_SHA: "abc123", NODE_ENV: "test" as const };

describe("config", () => {
  it("requires DATABASE_URL and, in production, a shape secret", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production" })).toThrow(/SHAPI_SHAPE_SECRET is required/);
    const c = loadConfig({ DATABASE_URL: "postgres://x", CANARY_PROVIDERS: "github, stripe" });
    expect(c).toMatchObject({ PORT: 8080, CANARY_CRON: "7 * * * *", canaryProviders: ["github", "stripe"] });
  });
});

describe("web process", () => {
  it("answers health, readiness and version", async () => {
    const app = buildApp({ db, config: testConfig });
    expect((await app.inject("/healthz")).json()).toEqual({ ok: true });
    const ready = await app.inject("/readyz");
    expect(ready.statusCode).toBe(200);
    expect((await app.inject("/version")).json()).toEqual({ name: "shapi", sha: "abc123" });
    await app.close();
  });

  it("reports not ready, but stays alive, when the database is down", async () => {
    const dead = createDb({ connectionString: "postgres://postgres:postgres@127.0.0.1:1/none" });
    const app = buildApp({ db: dead, config: testConfig });
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    const ready = await app.inject("/readyz");
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ ok: false, error: "database unavailable" });
    await app.close();
    await dead.destroy();
  });
});

describe("jobs", () => {
  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  /** GitHub as the canary sees it; the dispatch endpoint's answer is switchable. */
  const github = (dispatch: () => Response) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      if ((init?.method ?? "GET") === "POST") return dispatch();
      if (p === "/rate_limit") return json(200, { resources: { core: { limit: 5000, remaining: 4999 } } });
      if (p.endsWith("/actions/workflows")) return json(200, { total_count: 1, workflows: [{ id: 1, state: "active" }] });
      if (p.endsWith("/runs")) return json(200, { total_count: 1, workflow_runs: [{ id: 9, status: "completed" }] });
      return json(200, { id: 1, full_name: "octocat/Hello-World" });
    }) as typeof globalThis.fetch;
  const env = { SHAPI_SHAPE_SECRET: "test", SHAPI_GITHUB_TOKEN: "t", SHAPI_CANARY_REPO: "shapi-dev/canary", SHAPI_CANARY_WORKFLOW: "canary.yml" };

  it("canary job stores shapes in Postgres and files a draft advisory when the dispatch response breaks", async () => {
    let t = Date.UTC(2025, 11, 18);
    const now = () => new Date((t += 3_600_000));
    const first = await runCanaryJob({ db, env, providers: ["github"], fetch: github(() => new Response(null, { status: 204 })), now });
    expect(first).toMatchObject({ probes: 5, changed: 0, failed: 0, drafts: [] });

    const second = await runCanaryJob({ db, env, providers: ["github"], fetch: github(() => json(200, { workflow_run_id: 1, run_url: "https://x", html_url: "https://y" })), now });
    expect(second.changed).toBe(1);
    expect(second.drafts).toEqual(["github-workflows-dispatches-status-code-20251218"]);

    const store = new PgShapeStore(db);
    const history = await store.history("github", "POST", "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { source: "canary:github:token" });
    expect(history.map((o) => o.shape.status)).toEqual([200, 204]);
    const drafts = await listAdvisories(db, { includeDrafts: true });
    expect(drafts.find((a) => a.id === "github-workflows-dispatches-status-code-20251218")).toMatchObject({ status: "unverified", changeClass: "status-code" });
    // drafts never reach matching until reviewed
    expect((await listAdvisories(db)).map((a) => a.id)).not.toContain("github-workflows-dispatches-status-code-20251218");
  });

  it("advisory sync loads the reviewed advisories folder", async () => {
    expect(await syncAdvisoriesJob(db, ADVISORIES)).toBeGreaterThanOrEqual(7);
    expect((await listAdvisories(db)).length).toBeGreaterThanOrEqual(7);
  });
});

describe("worker", () => {
  it("starts pg-boss, registers the canary schedule, and processes queued jobs", async () => {
    const logs: string[] = [];
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "7 * * * *", SHAPI_ADVISORIES: ADVISORIES, canaryProviders: ["github"], WEBHOOK_SWEEP_CRON: "", WEBHOOK_RETENTION_DAYS: 14, SHAPI_RECORDINGS: path.join(root, "fixtures/recordings"), FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "", SHAPI_PUBLIC_URL: "https://shapi.test", GIT_SHA: "test" },
      env: { SHAPI_SHAPE_SECRET: "test" },
      log: { info: (_o, m) => logs.push(m ?? ""), error: (o, m) => logs.push(`ERROR ${m} ${String((o as { err?: unknown }).err)}`) },
      fetch: (async () => new Response("{}", { status: 200 })) as typeof globalThis.fetch,
    });
    try {
      const schedules = await boss.getSchedules();
      expect(schedules.map((s) => [s.name, s.cron])).toEqual([[QUEUES.canaryRun, "7 * * * *"]]);

      // the startup advisory sync job is processed by the worker
      const deadline = Date.now() + 30_000;
      while (!logs.includes("advisories synced") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(logs).toContain("advisories synced");

      // a manually queued canary run is processed too
      await boss.send(QUEUES.canaryRun, {});
      while (!logs.includes("canary run finished") && Date.now() < deadline + 30_000) await new Promise((r) => setTimeout(r, 250));
      expect(logs).toContain("canary run finished");
      expect(logs.filter((l) => l.startsWith("ERROR"))).toEqual([]);
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 90_000);
});
