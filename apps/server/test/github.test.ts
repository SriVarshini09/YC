import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateToLatest, withService, withTenant, type Db } from "@shapi/db";
import { signWebhook } from "@shapi/github-app";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { QUEUES, buildApp, githubClients, loadConfig, processDelivery, startWorker, sweepWebhooks, type GitHubClients } from "../src/index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SECRET = "webhook-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const githubApp = { appId: "123", privateKey, webhookSecret: SECRET };
const config = { LOG_LEVEL: "info" as const, GIT_SHA: "t", NODE_ENV: "test" as const, githubApp };

let pg: TestPostgres;
let db: Db;
let owner: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_github");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

beforeEach(async () => {
  await owner.deleteFrom("accounts").execute();
  await owner.deleteFrom("webhook_deliveries").execute();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
};

/** A fake GitHub: the installation's repositories are mutable so tests can add and remove them. */
function fakeGitHub() {
  const state = {
    repos: [
      { id: 501, full_name: "acme/api", default_branch: "main", private: true },
      { id: 502, full_name: "acme/web", default_branch: "trunk", private: false },
    ] as { id: number; full_name: string; default_branch: string; private: boolean; archived?: boolean }[],
    deliveries: [] as unknown[],
    failRepos: false,
  };
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(route);
    let res: Response;
    if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(route)) {
      res = json(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" });
    } else if (route === "GET /installation/repositories") {
      res = state.failRepos ? json(502, { message: "bad gateway" }) : json(200, { total_count: state.repos.length, repositories: state.repos });
    } else if (/^GET \/app\/installations\/\d+$/.test(route)) {
      res = json(200, { id: Number(url.pathname.split("/").pop()), account: { login: "late-org", type: "Organization" }, suspended_at: null });
    } else if (route === "GET /app/hook/deliveries") {
      res = json(200, state.deliveries);
    } else if (/^POST \/app\/hook\/deliveries\/\d+\/attempts$/.test(route)) {
      res = json(202, {});
    } else {
      res = json(404, { message: `no route ${route}` });
    }
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof globalThis.fetch;
  return { state, calls, fetch, clients: githubClients(githubApp, { fetch, resilient: false }) as GitHubClients };
}

const installation = (id: number, login = "acme") => ({ id, account: { login, type: "Organization" } });

/** Store a delivery the way the webhook route does, and return its id. */
async function deliver(event: string, payload: object): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("webhook_deliveries")
    .values({ delivery_id: id, event, action: (payload as { action?: string }).action ?? null, installation_id: null, payload: JSON.stringify(payload) })
    .execute();
  return id;
}

const push = (installationId: number, repo: { id: number; full_name: string; default_branch: string }, after: string, ref = `refs/heads/${repo.default_branch}`) => ({
  ref,
  after,
  deleted: false,
  installation: { id: installationId },
  repository: { ...repo, private: true },
});

describe("config", () => {
  it("takes all three GitHub App settings or none", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).githubApp).toBeUndefined();
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", SHAPI_GITHUB_APP_ID: "1" })).toThrow(/or none/);
    const c = loadConfig({ DATABASE_URL: "postgres://x", SHAPI_GITHUB_APP_ID: "1", SHAPI_GITHUB_APP_PRIVATE_KEY: "k", SHAPI_GITHUB_WEBHOOK_SECRET: "s" });
    expect(c.githubApp).toEqual({ appId: "1", privateKey: "k", webhookSecret: "s" });
    expect(c.WEBHOOK_SWEEP_CRON).toBe("*/10 * * * *");
  });
});

describe("POST /github/webhook", () => {
  const send = (app: ReturnType<typeof buildApp>, body: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/github/webhook", payload: body, headers: { "content-type": "application/json", ...headers } });
  const body = JSON.stringify({ action: "created", installation: { id: 77 } });
  const signed = (id: string, b = body) => ({ "x-github-event": "installation", "x-github-delivery": id, "x-hub-signature-256": signWebhook(SECRET, b) });

  it("answers 503 until the app is configured", async () => {
    const app = buildApp({ db, config: { ...config, githubApp: undefined } });
    expect((await send(app, body, signed("d0"))).statusCode).toBe(503);
    await app.close();
  });

  it("rejects bad signatures and missing headers, stores a delivery once, and queues it", async () => {
    const queued: string[] = [];
    const app = buildApp({ db, config, enqueueWebhook: async (id) => void queued.push(id) });

    expect((await send(app, body, { ...signed("d1"), "x-hub-signature-256": signWebhook("wrong", body) })).statusCode).toBe(401);
    expect((await send(app, `${body} `, signed("d1"))).statusCode).toBe(401);
    expect((await send(app, body, { "x-hub-signature-256": signWebhook(SECRET, body) })).statusCode).toBe(400);

    const first = await send(app, body, signed("d1"));
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ ok: true });
    const again = await send(app, body, signed("d1"));
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect(queued).toEqual(["d1"]);

    const row = await db.selectFrom("webhook_deliveries").selectAll().where("delivery_id", "=", "d1").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ event: "installation", action: "created", installation_id: "77", processed_at: null });
    expect(row.payload).toEqual({ action: "created", installation: { id: 77 } });
    await app.close();
  });

  it("still accepts and stores the delivery when queueing fails (the sweeper queues it)", async () => {
    const app = buildApp({ db, config, enqueueWebhook: async () => Promise.reject(new Error("queue down")) });
    expect((await send(app, body, signed("d2"))).statusCode).toBe(202);
    expect(await db.selectFrom("webhook_deliveries").select("delivery_id").where("delivery_id", "=", "d2").executeTakeFirst()).toBeTruthy();
    await app.close();
  });
});

describe("webhook events", () => {
  it("installation created: creates the account and its repositories; a second run is a no-op", async () => {
    const gh = fakeGitHub();
    const id = await deliver("installation", { action: "created", installation: installation(9001) });
    expect((await processDelivery({ db, github: gh.clients }, id)).outcome).toMatch(/synced with 2 repositories/);
    expect((await processDelivery({ db, github: gh.clients }, id)).outcome).toBe("already processed");

    const repos = await withService(db, (tx) => tx.selectFrom("repositories").select(["full_name", "default_branch", "private", "enabled"]).orderBy("full_name").execute());
    expect(repos).toEqual([
      { full_name: "acme/api", default_branch: "main", private: true, enabled: true },
      { full_name: "acme/web", default_branch: "trunk", private: false, enabled: true },
    ]);
    expect(gh.calls).toContain("POST /app/installations/9001/access_tokens");
    // nothing is visible outside a tenant or service context
    expect(await db.selectFrom("repositories").selectAll().execute()).toEqual([]);
  });

  it("keeps each installation's rows to its own tenant", async () => {
    const gh = fakeGitHub();
    await processDelivery({ db, github: gh.clients }, await deliver("installation", { action: "created", installation: installation(1, "one") }));
    gh.state.repos = [{ id: 601, full_name: "two/app", default_branch: "main", private: true }];
    await processDelivery({ db, github: gh.clients }, await deliver("installation", { action: "created", installation: installation(2, "two") }));

    const accounts = await withService(db, (tx) => tx.selectFrom("accounts").select(["id", "login"]).orderBy("login").execute());
    const two = accounts.find((a) => a.login === "two")!;
    const seen = await withTenant(db, two.id, (tx) => tx.selectFrom("repositories").select("full_name").execute());
    expect(seen).toEqual([{ full_name: "two/app" }]);
  });

  it("installation_repositories: resyncs, removing repositories the app lost", async () => {
    const gh = fakeGitHub();
    await processDelivery({ db, github: gh.clients }, await deliver("installation", { action: "created", installation: installation(9002) }));
    gh.state.repos = gh.state.repos.filter((r) => r.id === 502).concat({ id: 503, full_name: "acme/new", default_branch: "main", private: true, archived: true });
    const id = await deliver("installation_repositories", { action: "removed", installation: installation(9002), repositories_removed: [{ id: 501 }] });
    expect((await processDelivery({ db, github: gh.clients }, id)).outcome).toBe("repositories synced (2)");
    const repos = await withService(db, (tx) => tx.selectFrom("repositories").select(["full_name", "enabled"]).orderBy("full_name").execute());
    expect(repos).toEqual([
      { full_name: "acme/new", enabled: false },
      { full_name: "acme/web", enabled: true },
    ]);
  });

  it("push to the default branch queues one scan per commit; other pushes are ignored", async () => {
    const gh = fakeGitHub();
    await processDelivery({ db, github: gh.clients }, await deliver("installation", { action: "created", installation: installation(9003) }));
    const repo = { id: 501, full_name: "acme/api", default_branch: "main" };
    const run = async (payload: object) => (await processDelivery({ db, github: gh.clients }, await deliver("push", payload))).outcome;

    expect(await run(push(9003, repo, "a".repeat(40)))).toMatch(/^scan \d+ queued$/);
    expect(await run(push(9003, repo, "a".repeat(40)))).toMatch(/already queued/);
    expect(await run(push(9003, repo, "b".repeat(40), "refs/heads/feature"))).toBe("ignored: not the default branch");
    expect(await run({ ...push(9003, repo, "0".repeat(40)), deleted: true })).toBe("ignored: branch deleted");

    const scans = await withService(db, (tx) => tx.selectFrom("scans").select(["sha", "status"]).execute());
    expect(scans).toEqual([{ sha: "a".repeat(40), status: "queued" }]);
  });

  it("push from an installation whose install event was lost creates the account from the API", async () => {
    const gh = fakeGitHub();
    const outcome = (await processDelivery({ db, github: gh.clients }, await deliver("push", push(9004, { id: 501, full_name: "acme/api", default_branch: "main" }, "c".repeat(40))))).outcome;
    expect(outcome).toMatch(/queued/);
    expect(gh.calls).toContain("GET /app/installations/9004");
    const account = await withService(db, (tx) => tx.selectFrom("accounts").select(["login", "github_installation_id"]).executeTakeFirstOrThrow());
    expect(account).toEqual({ login: "late-org", github_installation_id: "9004" });
  });

  it("suspend stops scans, unsuspend resumes, deleted removes everything", async () => {
    const gh = fakeGitHub();
    const repo = { id: 501, full_name: "acme/api", default_branch: "main" };
    const run = async (event: string, payload: object) => (await processDelivery({ db, github: gh.clients }, await deliver(event, payload))).outcome;
    await run("installation", { action: "created", installation: installation(9005) });

    expect(await run("installation", { action: "suspend", installation: { ...installation(9005), suspended_at: "2026-10-22T00:00:00Z" } })).toBe("account suspended");
    expect(await run("push", push(9005, repo, "d".repeat(40)))).toBe("ignored: account suspended");
    await run("installation", { action: "unsuspend", installation: installation(9005) });
    expect(await run("push", push(9005, repo, "d".repeat(40)))).toMatch(/queued/);

    expect(await run("installation", { action: "deleted", installation: installation(9005) })).toBe("account removed (1)");
    const left = await withService(db, async (tx) => ({
      accounts: await tx.selectFrom("accounts").selectAll().execute(),
      repos: await tx.selectFrom("repositories").selectAll().execute(),
      scans: await tx.selectFrom("scans").selectAll().execute(),
    }));
    expect(left).toEqual({ accounts: [], repos: [], scans: [] });
  });

  it("a failure rolls back, records the error and rethrows so the job retries", async () => {
    const gh = fakeGitHub();
    gh.state.failRepos = true;
    const id = await deliver("installation", { action: "created", installation: installation(9006) });
    await expect(processDelivery({ db, github: gh.clients }, id)).rejects.toThrow();
    const row = await db.selectFrom("webhook_deliveries").select(["processed_at", "error"]).where("delivery_id", "=", id).executeTakeFirstOrThrow();
    expect(row.processed_at).toBeNull();
    expect(row.error).toMatch(/bad gateway/);
    expect(await withService(db, (tx) => tx.selectFrom("accounts").selectAll().execute())).toEqual([]);
  });

  it("ignores events it does not handle, but marks them processed", async () => {
    const gh = fakeGitHub();
    const id = await deliver("star", { action: "created" });
    expect((await processDelivery({ db, github: gh.clients }, id)).outcome).toBe("ignored: star");
    expect((await processDelivery({ db, github: gh.clients }, id)).outcome).toBe("already processed");
  });
});

describe("webhook sweeper", () => {
  it("re-queues stored deliveries, redelivers ones GitHub failed to send, and prunes old payloads", async () => {
    const gh = fakeGitHub();
    const now = new Date();
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    await owner
      .insertInto("webhook_deliveries")
      .values([
        { delivery_id: "stuck", event: "push", action: null, installation_id: null, payload: "{}", received_at: ago(10) },
        { delivery_id: "fresh", event: "push", action: null, installation_id: null, payload: "{}", received_at: ago(0) },
        { delivery_id: "errored", event: "push", action: null, installation_id: null, payload: "{}", received_at: ago(10), error: "boom" },
        { delivery_id: "old", event: "push", action: null, installation_id: null, payload: "{}", received_at: ago(30 * 1440), processed_at: ago(30 * 1440) },
        { delivery_id: "recent", event: "push", action: null, installation_id: null, payload: "{}", received_at: ago(60), processed_at: ago(60) },
      ])
      .execute();
    gh.state.deliveries = [
      { id: 11, guid: "missed", status_code: 0, delivered_at: ago(30).toISOString(), redelivery: false, event: "push" },
      { id: 12, guid: "recent", status_code: 500, delivered_at: ago(60).toISOString(), redelivery: false, event: "push" },
      { id: 13, guid: "fine", status_code: 202, delivered_at: ago(20).toISOString(), redelivery: false, event: "push" },
    ];
    const queued: string[] = [];
    const result = await sweepWebhooks({ db, github: gh.clients, enqueue: async (id) => void queued.push(id), retentionDays: 14, now });

    expect(queued).toEqual(["stuck"]);
    expect(gh.calls).toContain("POST /app/hook/deliveries/11/attempts");
    expect(gh.calls.filter((c) => c.endsWith("/attempts"))).toHaveLength(1);
    expect(result).toEqual({ requeued: 1, redelivered: 1, givenUp: 0, failed: 1, pruned: 1 });
    const left = await db.selectFrom("webhook_deliveries").select("delivery_id").orderBy("delivery_id").execute();
    expect(left.map((r) => r.delivery_id)).toEqual(["errored", "fresh", "recent", "stuck"]);
  });
});

describe("worker", () => {
  it("processes a queued webhook delivery and schedules the sweeper", async () => {
    const gh = fakeGitHub();
    const logs: string[] = [];
    const boss = await startWorker({
      databaseUrl: pg.url,
      db,
      config: { CANARY_CRON: "", SHAPI_ADVISORIES: path.join(root, "advisories"), WEBHOOK_SWEEP_CRON: "*/10 * * * *", WEBHOOK_RETENTION_DAYS: 14, githubApp, SHAPI_RECORDINGS: path.join(root, "fixtures/recordings"), FANOUT_CRON: "", ADVISORIES_SYNC_CRON: "" },
      env: {},
      log: { info: (_o, m) => logs.push(m ?? ""), error: (o, m) => logs.push(`ERROR ${m} ${String((o as { err?: unknown }).err)}`) },
      fetch: gh.fetch,
    });
    try {
      expect((await boss.getSchedules()).map((s) => s.name)).toEqual([QUEUES.webhookSweep]);
      const id = await deliver("installation", { action: "created", installation: installation(9100) });
      await boss.send(QUEUES.githubWebhook, { deliveryId: id });
      const deadline = Date.now() + 30_000;
      while (!logs.includes("webhook processed") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      expect(logs.filter((l) => l.startsWith("ERROR"))).toEqual([]);
      expect(logs).toContain("webhook processed");
      const row = await db.selectFrom("webhook_deliveries").select("processed_at").where("delivery_id", "=", id).executeTakeFirstOrThrow();
      expect(row.processed_at).not.toBeNull();
    } finally {
      await boss.stop({ graceful: false, timeout: 5_000 });
    }
  }, 90_000);
});
