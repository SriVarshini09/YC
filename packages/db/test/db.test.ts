import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAdvisories } from "@shapi/core";
import { sql } from "kysely";
import { inferShape, providerSalt } from "@shapi/shapes";
import { MIGRATION_LOCK_TIMEOUT, PgShapeStore, createDb, listAdvisories, migrateToLatest, upsertAdvisories, withLockTimeout, withService, withTenant, type Db } from "@shapi/db";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pg: TestPostgres;
let owner: Db;
let app: Db;

beforeAll(async () => {
  pg = await startTestPostgres();
  owner = createDb({ connectionString: pg.url, appRole: false });
  expect(await migrateToLatest(owner)).toEqual(["0001_init", "0002_webhook_sweeper", "0003_fix_prs", "0004_cloud_scans", "0005_web_sessions", "0006_billing", "0007_billing_cancel_at", "0008_fix_pr_repair", "0009_findings_scan_index", "0010_scans_fix_engine", "0011_session_repo_access", "0013_jobs_fixes", "0014_scans_llm_calls", "0015_fix_job_llm_calls", "0016_pr_feedback"]);
  app = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await app?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

describe("migrations", () => {
  it("are idempotent", async () => {
    expect(await migrateToLatest(owner)).toEqual([]);
  });
  it("keep the app role away from the migration bookkeeping", async () => {
    await expect(sql`select * from kysely_migration`.execute(app)).rejects.toThrow(/permission denied/);
  });
  it("wait at most the lock timeout for a table lock, and fail instead of queueing every query behind them", async () => {
    let seen: unknown;
    const [check] = Object.values(withLockTimeout({ check: { up: async (tx) => void (seen = (await sql<{ lock_timeout: string }>`show lock_timeout`.execute(tx)).rows[0]) } }));
    await owner.transaction().execute((tx) => check!.up(tx));
    expect(seen).toEqual({ lock_timeout: MIGRATION_LOCK_TIMEOUT });
    // Only for the migration's transaction.
    expect((await sql<{ lock_timeout: string }>`show lock_timeout`.execute(owner)).rows[0]).toEqual({ lock_timeout: "0" });

    // A long transaction holds a lock on the table: the migration gives up after the timeout.
    await sql`create table if not exists lock_probe (id int)`.execute(owner);
    let release!: () => void;
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holder = owner.transaction().execute(async (tx) => {
      await sql`lock table lock_probe in access share mode`.execute(tx);
      held();
      await new Promise<void>((r) => (release = r));
    });
    await isHeld;
    const [alter] = Object.values(withLockTimeout({ alter: { up: async (tx) => void (await sql`alter table lock_probe add column x int`.execute(tx)) } }, "200ms"));
    try {
      await expect(owner.transaction().execute((tx) => alter!.up(tx))).rejects.toThrow(/lock timeout/);
    } finally {
      release();
      await holder;
      await sql`drop table lock_probe`.execute(owner);
    }
  });
});

describe("app role connections", () => {
  it("fail closed when the role cannot be set, instead of running as the connecting user", async () => {
    await sql`do $$ begin if not exists (select 1 from pg_roles where rolname = 'outsider') then create role outsider login password 'outsider'; end if; end $$`.execute(owner);
    const outsider = createDb({ connectionString: pg.url.replace("postgres:postgres@", "outsider:outsider@"), max: 1 });
    try {
      await expect(sql`select current_user`.execute(outsider)).rejects.toThrow(/permission denied to set role/);
    } finally {
      await outsider.destroy();
    }
  });
});

describe("tenant isolation (row-level security)", () => {
  let acme: string;
  let globex: string;

  beforeAll(async () => {
    await withService(app, async (tx) => {
      acme = (await tx.insertInto("accounts").values({ login: "acme", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow()).id;
      globex = (await tx.insertInto("accounts").values({ login: "globex", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow()).id;
      for (const [account, name, id] of [[acme, "acme/web", 1], [acme, "acme/api", 2], [globex, "globex/site", 3]] as const) {
        await tx.insertInto("repositories").values({ account_id: account, github_repo_id: id, full_name: name, default_branch: "main", private: true }).execute();
      }
    });
  });

  it("shows a tenant only its own rows, even without a where clause", async () => {
    const acmeRepos = await withTenant(app, acme, (tx) => tx.selectFrom("repositories").select("full_name").orderBy("full_name").execute());
    expect(acmeRepos.map((r) => r.full_name)).toEqual(["acme/api", "acme/web"]);
    const globexAccounts = await withTenant(app, globex, (tx) => tx.selectFrom("accounts").select("login").execute());
    expect(globexAccounts.map((a) => a.login)).toEqual(["globex"]);
  });

  it("shows nothing outside a tenant or service context", async () => {
    expect(await app.selectFrom("repositories").selectAll().execute()).toEqual([]);
    expect(await app.selectFrom("accounts").selectAll().execute()).toEqual([]);
  });

  it("refuses to write a row into another tenant", async () => {
    await expect(
      withTenant(app, acme, (tx) =>
        tx.insertInto("repositories").values({ account_id: globex, github_repo_id: 99, full_name: "globex/sneaky", default_branch: "main", private: true }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(app, acme, (tx) => tx.updateTable("repositories").set({ enabled: false }).where("full_name", "=", "globex/site").executeTakeFirst());
    expect(Number(updated.numUpdatedRows)).toBe(0);
    const still = await withService(app, (tx) => tx.selectFrom("repositories").select("enabled").where("full_name", "=", "globex/site").executeTakeFirstOrThrow());
    expect(still.enabled).toBe(true);
  });

  it("survives the server dropping its idle connections, and reconnects", async () => {
    const errors: Error[] = [];
    const client = createDb({ connectionString: pg.url, onError: (err) => errors.push(err) });
    await sql`select 1`.execute(client);
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where usename = 'postgres' and pid <> pg_backend_pid() and state = 'idle' and backend_type = 'client backend'`.execute(owner);
    await new Promise((r) => setTimeout(r, 200));
    expect(errors.length).toBeGreaterThan(0);
    expect((await sql<{ ok: number }>`select 1 as ok`.execute(client)).rows).toEqual([{ ok: 1 }]);
    await client.destroy();
  });

  it("rejects malformed account ids", async () => {
    await expect(withTenant(app, "1 or 1=1", async () => 1)).rejects.toThrow(/invalid account id/);
  });
});

describe("PgShapeStore", () => {
  const salt = providerSalt("github", "test");
  const ENDPOINT = "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
  const shape = (status: number, body?: unknown) =>
    inferShape({ status, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, { salt });

  it("behaves like the SQLite store: latest, history, previous distinct, endpoints by source", async () => {
    const store = new PgShapeStore(app);
    const base = { provider: "github", method: "POST", endpoint: ENDPOINT, source: "canary:github:token" };
    const a = await store.record({ ...base, observedAt: "2025-12-18T10:00:00Z", shape: shape(204) });
    await store.record({ ...base, observedAt: "2025-12-18T22:00:00Z", shape: shape(204) });
    const c = await store.record({ ...base, observedAt: "2025-12-19T10:00:00Z", shape: shape(200, { workflow_run_id: 1 }) });
    await store.record({ ...base, source: "canary:github:anonymous", observedAt: "2025-12-20T10:00:00Z", shape: shape(404) });

    expect((await store.latest("github", "POST", ENDPOINT, base.source))?.id).toBe(c.id);
    expect((await store.history("github", "POST", ENDPOINT, { source: base.source })).map((o) => o.shape.status)).toEqual([200, 204, 204]);
    expect(await store.previousDistinct("github", "POST", ENDPOINT, base.source)).toMatchObject({ shapeHash: a.shapeHash, observedAt: "2025-12-18T22:00:00.000Z" });
    expect(await store.endpoints()).toEqual([
      { provider: "github", method: "POST", endpoint: ENDPOINT, source: "canary:github:anonymous", observations: 1, distinctShapes: 1, lastObservedAt: "2025-12-20T10:00:00.000Z" },
      { provider: "github", method: "POST", endpoint: ENDPOINT, source: "canary:github:token", observations: 3, distinctShapes: 2, lastObservedAt: "2025-12-19T10:00:00.000Z" },
    ]);
  });
});

describe("observation pruning", () => {
  const salt = providerSalt("github", "test");
  const ENDPOINT = "/repos/{owner}/{repo}/actions/runs";
  const shape = (status: number) => inferShape({ status, headers: {}, body: "" }, { salt });

  it("deletes old repeats of a shape and keeps the newest of every shape, and everything recent", async () => {
    const store = new PgShapeStore(app);
    const base = { provider: "github", method: "GET", endpoint: ENDPOINT, source: "canary:prune-test" };
    const at = (day: number, status: number) => store.record({ ...base, observedAt: new Date(Date.UTC(2025, 0, day, 12)).toISOString(), shape: shape(status) });
    await at(1, 200); // old repeat of 200: pruned
    await at(2, 200); // old repeat of 200: pruned
    const old204 = await at(3, 204); // the only 204 ever: kept however old
    await at(4, 200); // old repeat of 200: pruned
    const newest200Old = await at(5, 200); // the newest old 200, but a newer 200 exists (day 20): pruned
    const recent = [await at(20, 200), await at(21, 200)]; // after the cutoff: kept
    const other = await store.record({ ...base, source: "canary:prune-other", observedAt: "2025-01-01T12:00:00Z", shape: shape(200) }); // another source: its own newest

    const pruned = await store.prune(new Date(Date.UTC(2025, 0, 10)));
    expect(pruned).toBe(4);
    const left = (await store.history("github", "GET", ENDPOINT, { source: base.source })).map((o) => o.id);
    expect(left).toEqual([recent[1]!.id, recent[0]!.id, old204.id]);
    expect(left).not.toContain(newest200Old.id);
    expect((await store.latest("github", "GET", ENDPOINT, "canary:prune-other"))?.id).toBe(other.id);
    expect(await store.previousDistinct("github", "GET", ENDPOINT, base.source)).toMatchObject({ id: old204.id });
    // Pruning again changes nothing.
    expect(await store.prune(new Date(Date.UTC(2025, 0, 10)))).toBe(0);
  });
});

describe("advisories", () => {
  const seeded = loadAdvisories(path.join(root, "advisories"));

  it("syncs reviewed advisories and lists them for the matcher", async () => {
    expect(await upsertAdvisories(app, seeded, { reviewed: true, source: "repo" })).toBe(seeded.length);
    expect((await listAdvisories(app)).map((a) => a.id)).toEqual(seeded.map((a) => a.id).sort());
  });

  it("re-syncing an unchanged advisory changes nothing, so it does not look new", async () => {
    const advisory = loadAdvisories(path.join(root, "advisories"))[0]!;
    await upsertAdvisories(app, [advisory], { reviewed: true, source: "repo" });
    const first = await app.selectFrom("advisories").select("modified").where("id", "=", advisory.id).executeTakeFirstOrThrow();
    expect(await upsertAdvisories(app, [advisory], { reviewed: true, source: "repo" })).toBe(0);
    const again = await app.selectFrom("advisories").select("modified").where("id", "=", advisory.id).executeTakeFirstOrThrow();
    expect(again.modified.getTime()).toBe(first.modified.getTime());
    expect(await upsertAdvisories(app, [{ ...advisory, title: `${advisory.title} (edited)` }], { reviewed: true, source: "repo" })).toBe(1);
    const changed = await app.selectFrom("advisories").select("modified").where("id", "=", advisory.id).executeTakeFirstOrThrow();
    expect(changed.modified.getTime()).toBeGreaterThan(first.modified.getTime());
    await upsertAdvisories(app, [advisory], { reviewed: true, source: "repo" });
  });

  it("never lets a machine draft overwrite a reviewed advisory, and hides drafts by default", async () => {
    const reviewed = seeded[0]!;
    const draft = { ...seeded[1]!, id: "github-draft-1", status: "unverified" as const };
    await upsertAdvisories(app, [{ ...reviewed, title: "machine rewrite" }, draft], { reviewed: false, source: "canary" });
    const all = await listAdvisories(app, { includeDrafts: true });
    expect(all.find((a) => a.id === reviewed.id)?.title).toBe(reviewed.title);
    expect(all.map((a) => a.id)).toContain("github-draft-1");
    expect((await listAdvisories(app)).map((a) => a.id)).not.toContain("github-draft-1");
  });
});
