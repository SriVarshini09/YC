import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, migrateToLatest, PgShapeStore, type Db } from "@shapi/db";
import { createSensor } from "@shapi/sensor";
import { inferShape, providerSalt } from "@shapi/shapes";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { buildApp, createSensorToken, revokeSensorToken, sensorChanges, sensorSource } from "../src/index";

// Execution plan F-01: the traffic add-on, from a customer's process to a counted change the canary confirms.
let pg: TestPostgres;
let db: Db;
let owner: Db;
const SECRET = "test-shape-secret";
const DISPATCH = "https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches";
const ENDPOINT = "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";

beforeAll(async () => {
  pg = await startTestPostgres("shapi_sensor");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

const config = { LOG_LEVEL: "info" as const, GIT_SHA: "t", NODE_ENV: "test" as const, SHAPI_SHAPE_SECRET: SECRET };

/** GitHub as one customer sees it: workflow_dispatch answers 204, then (after the change) 200 with the run's ids. */
const dispatchResponse = (after: boolean) =>
  after
    ? new Response(JSON.stringify({ workflow_run_id: 22000000001, run_url: "https://api.github.com/repos/acme/app/actions/runs/22000000001", html_url: "https://github.com/acme/app/actions/runs/22000000001" }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-github-api-version-selected": "2022-11-28" } })
    : new Response(null, { status: 204, headers: { "x-github-api-version-selected": "2022-11-28" } });

/** A customer's process: its own GitHub, and uploads that go to the app under test. */
function customer(app: ReturnType<typeof buildApp>, token: string, state: { after: boolean }) {
  const uploads: unknown[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.github.com/")) return url.endsWith("/dispatches") ? dispatchResponse(state.after) : new Response("{}", { status: 200 });
    if (url.startsWith("https://api.example.com/")) return new Response(JSON.stringify({ secret: "value" }), { status: 200 });
    uploads.push(JSON.parse(String(init?.body)));
    const res = await app.inject({ method: "POST", url: new URL(url).pathname, headers: { authorization: String((init?.headers as Record<string, string>).authorization), "content-type": "application/json" }, payload: String(init?.body) });
    return new Response(res.body, { status: res.statusCode });
  }) as typeof globalThis.fetch;
  const sensor = createSensor({ token, fetch, endpoint: "http://localhost/api/v1/sensor/observations", flushMs: 3_600_000 });
  return { sensor, uploads };
}

async function account(login: string, id: number) {
  const a = await owner.insertInto("accounts").values({ github_installation_id: id, login, type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
  return a.id;
}

describe("traffic sensor (F-01)", () => {
  it("counts a change once three accounts see it, and marks it confirmed when the canary saw it too", async () => {
    const app = buildApp({ db, config, fetch: globalThis.fetch });
    const state = { after: false };
    const ids = [await account("acme", 1001), await account("globex", 1002), await account("initech", 1003)];
    const customers = await Promise.all(ids.map(async (id) => customer(app, await createSensorToken(db, id), state)));

    // Before the change: each customer dispatches twice, and calls an API SHAPI doesn't watch.
    for (const c of customers) {
      await c.sensor.fetch(DISPATCH, { method: "POST", body: "{}" });
      await c.sensor.fetch(DISPATCH, { method: "POST", body: "{}" });
      await c.sensor.fetch("https://api.example.com/v1/things");
      await c.sensor.flush();
    }
    const first = customers[0]!.uploads[0] as { observations: { endpoint: string; count: number; shape: { status: number } }[] };
    expect(first.observations).toEqual([expect.objectContaining({ provider: "github", method: "POST", endpoint: ENDPOINT, count: 2, shape: { status: 204, headers: { "x-github-api-version-selected": "2022-11-28" }, body: { kind: "empty", fields: [] } } })]);
    // Value-free: no ids, URLs, owner or repository names leave the process.
    expect(JSON.stringify(customers.map((c) => c.uploads))).not.toMatch(/acme|ci\.yml|22000000001|secret|example\.com/);

    // GitHub changes. Two customers see it first: not enough to count.
    state.after = true;
    for (const c of customers.slice(0, 2)) {
      await c.sensor.fetch(DISPATCH, { method: "POST", body: "{}" });
      await c.sensor.flush();
    }
    expect(await sensorChanges(db)).toEqual([]);

    // The third does: now it counts. The canary hasn't probed yet, so it isn't confirmed.
    await customers[2]!.sensor.fetch(DISPATCH, { method: "POST", body: "{}" });
    await customers[2]!.sensor.flush();
    const counted = await sensorChanges(db);
    expect(counted.map((c) => [c.detail, c.accounts, Boolean(c.canary)])).toEqual(expect.arrayContaining([[expect.stringMatching(/204.*200/), 3, false]]));

    // The canary probes GitHub before and after the change, with its own test account and payload.
    const store = new PgShapeStore(db);
    const salt = providerSalt("github", SECRET);
    const source = "canary:github:token";
    for (const [after, at] of [[false, "2026-02-18T09:00:00Z"], [true, "2026-02-19T09:00:00Z"]] as const) {
      const res = dispatchResponse(after);
      await store.record({ provider: "github", method: "POST", endpoint: ENDPOINT, observedAt: at, source, shape: inferShape({ status: res.status, headers: res.headers, body: await res.text() }, { salt }) });
    }
    const confirmed = await sensorChanges(db);
    const status = confirmed.find((c) => /204.*200/.test(c.detail))!;
    expect(status).toMatchObject({ provider: "github", method: "POST", endpoint: ENDPOINT, accounts: 3, canary: { source, observedAt: "2026-02-19T09:00:00.000Z" } });
    // That is the change GitHub made (github-workflow-dispatch-204-to-200), seen by three customers and the canary.
    expect(confirmed).toHaveLength(1);
    await app.close();
  }, 60_000);

  it("takes uploads only with a valid token, and stores nothing for endpoints the sensor doesn't watch", async () => {
    const app = buildApp({ db, config, fetch: globalThis.fetch });
    const id = await account("umbrella", 1004);
    const token = await createSensorToken(db, id);
    const batch = (endpoint: string) => ({ v: 1, sdk: "python", observations: [{ provider: "github", method: "GET", endpoint, shape: { status: 200, headers: {}, body: { kind: "empty", fields: [] } }, count: 1, firstSeen: "2026-10-30T00:00:00Z", lastSeen: "2026-10-30T00:00:00Z" }] });
    const post = (auth: string, payload: unknown) => app.inject({ method: "POST", url: "/api/v1/sensor/observations", headers: { authorization: auth, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect((await post("Bearer shapi_sensor_not-a-real-token-at-all", batch("/user"))).statusCode).toBe(401);
    expect((await post(`Bearer ${token}`, { v: 2 })).statusCode).toBe(400);
    const res = await post(`Bearer ${token}`, batch("/repos/acme/secret-repo/issues"));
    expect([res.statusCode, res.json()]).toEqual([200, { stored: 0, dropped: 1 }]);
    const rows = await owner.selectFrom("observations").select("endpoint").where("source", "=", sensorSource(id)).execute();
    expect(rows).toEqual([]);
    await revokeSensorToken(db, id);
    expect((await post(`Bearer ${token}`, batch("/user"))).statusCode).toBe(401);
    await app.close();
  }, 60_000);
});
