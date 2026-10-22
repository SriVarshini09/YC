import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ShapeStore } from "@shapi/shapes";
import { githubWorker, run, runEvery, runOnce, stripeWorker, type Env } from "@shapi/canary";

const env: Env = { SHAPI_SHAPE_SECRET: "test" };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** Fake fetch: answers by URL path, records requests. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) throw new Error(`no route for ${url.pathname}`);
    return route();
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const githubRoutes = (dispatch: () => Response) => ({
  "GET /rate_limit": () => json(200, { resources: { core: { limit: 60, remaining: 59 } } }),
  "GET /repos/octocat/Hello-World": () => json(200, { id: 1296269, full_name: "octocat/Hello-World", private: false }),
  "GET /repos/actions/checkout/actions/workflows": () => json(200, { total_count: 1, workflows: [{ id: 1, state: "active" }] }),
  "GET /repos/actions/checkout/actions/runs": () => json(200, { total_count: 1, workflow_runs: [{ id: 9, status: "completed" }] }),
  "POST /repos/shapi-dev/canary/actions/workflows/canary.yml/dispatches": dispatch,
});

const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-canary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("workers", () => {
  it("github runs public probes without credentials and explains the skipped dispatch probe", () => {
    const plan = githubWorker.probes({});
    expect(plan.probes.map((p) => p.id)).toEqual(["github:rate-limit", "github:get-repo", "github:list-workflows", "github:list-runs"]);
    expect(plan.probes[0]!.headers).not.toHaveProperty("Authorization");
    expect(plan.skipped.map((s) => s.id)).toEqual(["github:workflow-dispatch"]);
  });

  it("github adds the workflow_dispatch probe for a configured test repo", () => {
    const plan = githubWorker.probes({ SHAPI_GITHUB_TOKEN: "t", SHAPI_CANARY_REPO: "shapi-dev/canary", SHAPI_CANARY_WORKFLOW: "canary.yml" });
    const dispatch = plan.probes.find((p) => p.id === "github:workflow-dispatch");
    expect(dispatch).toMatchObject({
      method: "POST",
      endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      url: "https://api.github.com/repos/shapi-dev/canary/actions/workflows/canary.yml/dispatches",
      body: '{"ref":"main"}',
    });
    expect(() => githubWorker.probes({ SHAPI_GITHUB_TOKEN: "t", SHAPI_CANARY_REPO: "../x", SHAPI_CANARY_WORKFLOW: "w" })).toThrow();
  });

  it("stripe needs a test-mode key and refuses live keys", () => {
    expect(stripeWorker.probes({}).probes).toEqual([]);
    expect(stripeWorker.probes({}).skipped).toHaveLength(3);
    expect(stripeWorker.probes({ SHAPI_STRIPE_TEST_KEY: "sk_test_123" }).probes.map((p) => p.endpoint)).toEqual([
      "/v1/balance",
      "/v1/customers",
      "/v1/payment_intents",
    ]);
    expect(() => stripeWorker.probes({ SHAPI_STRIPE_TEST_KEY: "sk_live_123" })).toThrow(/test-mode key/);
  });
});

describe("runOnce", () => {
  const dispatchEnv: Env = { ...env, SHAPI_GITHUB_TOKEN: "t", SHAPI_CANARY_REPO: "shapi-dev/canary", SHAPI_CANARY_WORKFLOW: "canary.yml" };

  it("stores a shape per probe and flags the probe whose shape changed between runs", async () => {
    const store = ShapeStore.open(":memory:");
    let tick = 0;
    const now = () => new Date(Date.UTC(2025, 11, 18 + tick++));

    const before = fakeFetch(githubRoutes(() => new Response(null, { status: 204 })));
    const first = await runOnce({ store, env: dispatchEnv, fetch: before.fn, now, workers: [githubWorker] });
    expect(first.results.map((r) => [r.id, r.status, r.changed])).toEqual([
      ["github:rate-limit", 200, false],
      ["github:get-repo", 200, false],
      ["github:list-workflows", 200, false],
      ["github:list-runs", 200, false],
      ["github:workflow-dispatch", 204, false],
    ]);
    expect(before.calls.find((c) => c.method === "POST")?.headers).toMatchObject({ Authorization: "Bearer t" });

    const after = fakeFetch(githubRoutes(() => json(200, { workflow_run_id: 123, run_url: "https://api.github.com/r/1", html_url: "https://github.com/r/1" })));
    const second = await runOnce({ store, env: dispatchEnv, fetch: after.fn, now, workers: [githubWorker] });
    expect(second.results.filter((r) => r.changed).map((r) => r.id)).toEqual(["github:workflow-dispatch"]);
    const changed = second.results.find((r) => r.changed);
    expect(changed?.diff?.breaking).toBe(true);
    expect(changed?.diff?.changes[0]).toMatchObject({ kind: "status-code", changeClass: "status-code", from: 204, to: 200 });

    const endpoint = "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
    expect(store.history("github", "POST", endpoint).map((o) => o.shape.status)).toEqual([200, 204]);
    expect(store.latest("github", "POST", endpoint)?.source).toBe("canary:github:token");
    store.close();
  });

  it("does not report a change when the same endpoint is called first anonymously, then with a token", async () => {
    const store = ShapeStore.open(":memory:");
    const repoBody = (signedIn: boolean) => ({
      id: 1296269,
      full_name: "octocat/Hello-World",
      ...(signedIn ? { permissions: { admin: false, pull: true } } : { temp_clone_token: null }),
    });
    const routes = (signedIn: boolean) => ({
      ...githubRoutes(() => new Response(null, { status: 204 })),
      "GET /repos/octocat/Hello-World": () =>
        json(200, repoBody(signedIn), signedIn ? { "github-authentication-token-expiration": "2027-01-20 00:00:00 UTC" } : { "accept-ranges": "bytes" }),
    });
    const anonymous = await runOnce({ store, env, fetch: fakeFetch(routes(false)).fn, workers: [githubWorker] });
    const signedIn = await runOnce({ store, env: { ...env, SHAPI_GITHUB_TOKEN: "t" }, fetch: fakeFetch(routes(true)).fn, workers: [githubWorker] });
    expect(anonymous.results.every((r) => !r.previousHash)).toBe(true);
    // each auth mode starts its own history: "first", not "changed", and no draft
    expect(signedIn.results.filter((r) => r.changed || r.draft)).toEqual([]);
    expect(signedIn.results.every((r) => !r.previousHash)).toBe(true);

    const again = await runOnce({ store, env, fetch: fakeFetch(routes(false)).fn, workers: [githubWorker] });
    expect(again.results.every((r) => r.previousHash && !r.changed)).toBe(true);
    store.close();
  });

  it("reports network errors per probe without storing anything for them", async () => {
    const store = ShapeStore.open(":memory:");
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof globalThis.fetch;
    const report = await runOnce({ store, env, fetch: failing, workers: [githubWorker] });
    expect(report.results.every((r) => r.error === "ECONNRESET")).toBe(true);
    expect(store.endpoints()).toEqual([]);
    store.close();
  });

  it("filters by provider", async () => {
    const store = ShapeStore.open(":memory:");
    const report = await runOnce({ store, env, fetch: fakeFetch(githubRoutes(() => json(204, undefined))).fn, providers: ["stripe"] });
    expect(report.results).toEqual([]);
    expect(report.skipped.every((s) => s.id.startsWith("stripe:"))).toBe(true);
    store.close();
  });
});

describe("runEvery", () => {
  it("repeats on the interval until stopped", async () => {
    const store = ShapeStore.open(":memory:");
    const { fn } = fakeFetch(githubRoutes(() => json(204, undefined)));
    let reports = 0;
    await new Promise<void>((resolve) => {
      const stop = runEvery(5, { store, env, fetch: fn, workers: [githubWorker] }, () => {
        if (++reports === 3) {
          stop();
          resolve();
        }
      });
    });
    expect(reports).toBe(3);
    expect(store.endpoints().every((e) => e.observations === 3)).toBe(true);
    store.close();
  });
});

describe("shapi-canary CLI", () => {
  it("status lists observed endpoints", async () => {
    const db = path.join(dir, "shapes.db");
    const store = ShapeStore.open(db);
    await runOnce({ store, env, fetch: fakeFetch(githubRoutes(() => json(204, undefined))).fn, workers: [githubWorker] });
    store.close();
    let out = "";
    const code = await run(["node", "shapi-canary", "status", "--db", db], { stdout: (s) => (out += s), stderr: () => {} }, env);
    expect(code).toBe(0);
    expect(out).toContain("canary:github:anonymous  GET /repos/{owner}/{repo}  1 observations, 1 distinct shapes");
  });
});
