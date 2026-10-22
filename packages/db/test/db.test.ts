import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAdvisories } from "@shapi/core";
import { sql } from "kysely";
import { inferShape, providerSalt } from "@shapi/shapes";
import { PgShapeStore, createDb, listAdvisories, migrateToLatest, upsertAdvisories, withService, withTenant, type Db } from "@shapi/db";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pg: TestPostgres;
let owner: Db;
let app: Db;

beforeAll(async () => {
  pg = await startTestPostgres();
  owner = createDb({ connectionString: pg.url, appRole: false });
  expect(await migrateToLatest(owner)).toEqual(["0001_init", "0002_webhook_sweeper", "0003_fix_prs"]);
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

describe("advisories", () => {
  const seeded = loadAdvisories(path.join(root, "advisories"));

  it("syncs reviewed advisories and lists them for the matcher", async () => {
    expect(await upsertAdvisories(app, seeded, { reviewed: true, source: "repo" })).toBe(seeded.length);
    expect((await listAdvisories(app)).map((a) => a.id)).toEqual(seeded.map((a) => a.id).sort());
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
