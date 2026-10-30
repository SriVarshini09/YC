import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ShapeStore } from "@shapi/shapes";
import { anthropicWorker, githubWorker, hubspotWorker, openaiWorker, run, runEvery, runOnce, slackWorker, stripeWorker, twilioWorker, type Env } from "@shapi/canary";

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
  "GET /repos/actions/checkout/actions/workflows/test.yml/runs": () => json(200, { total_count: 1, workflow_runs: [{ id: 9, status: "completed" }] }),
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

  it("github's run listing asks for one stable kind of run: a successful push to main of one workflow, without PRs", () => {
    const runs = githubWorker.probes({}).probes.find((p) => p.id === "github:list-runs")!;
    expect(runs.endpoint).toBe("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs");
    const query = new URL(runs.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ branch: "main", event: "push", status: "success", exclude_pull_requests: "true", per_page: "1" });
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

  it("drafts nothing for one flaky response, and drafts a change once the next cycle sees it again (CN-03)", async () => {
    const store = ShapeStore.open(":memory:");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 1, tick++));
    const old = () => new Response(null, { status: 204 });
    const changed = () => json(200, { workflow_run_id: 1, run_url: "https://api.github.com/r/1", html_url: "https://github.com/r/1" });
    const cycle = async (dispatch: () => Response) =>
      (await runOnce({ store, env: dispatchEnv, fetch: fakeFetch(githubRoutes(dispatch)).fn, now, workers: [githubWorker] })).results.find((r) => r.id === "github:workflow-dispatch")!;

    // 204, then one 200, then 204 again: a candidate each time, never confirmed, never drafted.
    await cycle(old);
    const blip = await cycle(changed);
    expect(blip).toMatchObject({ changed: true, diff: { breaking: true } });
    expect(blip.draft).toBeUndefined();
    const back = await cycle(old);
    expect(back.changed).toBe(true);
    expect(back.confirmed).toBeUndefined();
    expect(back.draft).toBeUndefined();

    // 200 twice in a row: the second cycle confirms the change and drafts it, from the 204 before it.
    const first = await cycle(changed);
    expect(first.draft).toBeUndefined();
    const second = await cycle(changed);
    expect(second).toMatchObject({ changed: false, confirmed: true });
    expect(second.diff?.changes[0]).toMatchObject({ kind: "status-code", from: 204, to: 200 });
    expect(second.draft?.trigger.statusCodes).toEqual([204]);

    // A third cycle with the same shape is neither a change nor a new confirmation.
    const third = await cycle(changed);
    expect(third).toMatchObject({ changed: false });
    expect(third.confirmed).toBeUndefined();
    expect(third.draft).toBeUndefined();
    store.close();
  });

  it("learns a field that comes and goes as the endpoint's churn, and still drafts a real removal (CN-04)", async () => {
    const store = ShapeStore.open(":memory:");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 2, tick++));
    const repo = (extra: Record<string, unknown>) => () => json(200, { id: 1296269, full_name: "octocat/Hello-World", ...extra });
    const cycle = async (body: () => Response) =>
      (await runOnce({ store, env: {}, fetch: fakeFetch({ ...githubRoutes(() => new Response(null, { status: 204 })), "GET /repos/octocat/Hello-World": body }).fn, now, workers: [githubWorker] })).results.find((r) => r.id === "github:get-repo")!;

    // topics comes and goes: after it has flipped twice it is churn, and its coming and going is no change.
    await cycle(repo({ private: false, topics: ["a"] }));
    expect((await cycle(repo({ private: false }))).changed).toBe(true);
    const learned = await cycle(repo({ private: false, topics: ["b"] }));
    expect(learned).toMatchObject({ changed: false, churning: ["topics", "topics[]"] });
    for (const extra of [{ private: false }, { private: false, topics: ["c"] }, { private: false }]) {
      const r = await cycle(repo(extra));
      expect(r.changed).toBe(false);
      expect(r.draft).toBeUndefined();
    }

    // private disappears for good: a candidate, then confirmed and drafted, without topics in the diff.
    expect((await cycle(repo({ topics: ["d"] }))).changed).toBe(true);
    const confirmed = await cycle(repo({}));
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.diff?.changes.map((c) => `${c.kind} ${c.path}`)).toEqual(["field-removed private"]);
    expect(confirmed.draft).toBeDefined();
    store.close();
  });

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

  it("emits a value-free shape witness per probe, with the same shape_id while the shape holds (A-01)", async () => {
    const store = ShapeStore.open(":memory:");
    let tick = 0;
    const now = () => new Date(Date.UTC(2025, 11, 18 + tick++));
    const before = fakeFetch(githubRoutes(() => new Response(null, { status: 204 })));
    const first = await runOnce({ store, env: dispatchEnv, fetch: before.fn, now, workers: [githubWorker] });
    const again = await runOnce({ store, env: dispatchEnv, fetch: before.fn, now, workers: [githubWorker] });
    const after = fakeFetch(githubRoutes(() => json(200, { workflow_run_id: 123, run_url: "https://api.github.com/r/1", html_url: "https://github.com/r/1" })));
    const changed = await runOnce({ store, env: dispatchEnv, fetch: after.fn, now, workers: [githubWorker] });
    const dispatch = (r: typeof first) => r.results.find((p) => p.id === "github:workflow-dispatch")!.witness!;
    expect(dispatch(first)).toMatchObject({ source: "canary", provider: "github", method: "POST", status: 204, body: { kind: "empty" } });
    expect(first.results.every((r) => r.witness?.shapeId)).toBe(true);
    expect(dispatch(again).shapeId).toBe(dispatch(first).shapeId);
    expect(dispatch(again).observedAt).not.toBe(dispatch(first).observedAt);
    expect(dispatch(changed).shapeId).not.toBe(dispatch(first).shapeId);
    expect(dispatch(changed).body.fields).toEqual({ $: "object", "$.html_url": "string:url", "$.run_url": "string:url", "$.workflow_run_id": "integer" });
    expect(JSON.stringify(dispatch(changed))).not.toContain("api.github.com/r/1");
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

  it("a rate-limited response or a rejected key is a probe error: nothing is stored and nothing is drafted", async () => {
    const store = ShapeStore.open(":memory:");
    await runOnce({ store, env: dispatchEnv, fetch: fakeFetch(githubRoutes(() => new Response(null, { status: 204 }))).fn, workers: [githubWorker] });
    const answers = [
      () => json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
      () => json(429, { message: "slow down" }, { "retry-after": "60" }),
      () => json(401, { message: "Bad credentials" }),
    ];
    for (const answer of answers) {
      const routes = Object.fromEntries(Object.keys(githubRoutes(answer)).map((k) => [k, answer]));
      const report = await runOnce({ store, env: dispatchEnv, fetch: fakeFetch(routes).fn, workers: [githubWorker] });
      expect(report.results.every((r) => r.error && !r.draft && !r.changed)).toBe(true);
    }
    expect(store.endpoints().every((e) => e.observations === 1)).toBe(true);
    // an anonymous probe that starts answering 401 is a real auth change, and is recorded
    await runOnce({ store, env, fetch: fakeFetch(githubRoutes(() => json(204, undefined))).fn, workers: [githubWorker] });
    const anonymous = await runOnce({ store, env, fetch: fakeFetch({ ...githubRoutes(() => json(204, undefined)), "GET /repos/octocat/Hello-World": () => json(401, { message: "Requires authentication" }) }).fn, workers: [githubWorker] });
    expect(anonymous.results.find((r) => r.id === "github:get-repo")).toMatchObject({ status: 401, changed: true });
    store.close();
  });

  it("a misconfigured credential fails only its own provider", async () => {
    const store = ShapeStore.open(":memory:");
    const routes = {
      ...githubRoutes(() => json(204, undefined)),
      "GET /v1/balance": () => json(200, { object: "balance", available: [] }),
      "GET /v1/customers": () => json(200, { object: "list", data: [] }),
      "GET /v1/payment_intents": () => json(200, { object: "list", data: [] }),
    };
    const report = await runOnce({ store, env: { ...env, SHAPI_SLACK_BOT_TOKEN: "xoxp-user", SHAPI_STRIPE_TEST_KEY: "sk_test_1" }, fetch: fakeFetch(routes).fn, workers: [githubWorker, slackWorker, stripeWorker] });
    expect(report.results.filter((r) => r.error).map((r) => [r.id, r.error])).toEqual([["slack:config", "configuration: SHAPI_SLACK_BOT_TOKEN must be a bot token (xoxb-)"]]);
    expect(report.results.filter((r) => !r.error).map((r) => r.provider)).toEqual(["github", "github", "github", "github", "stripe", "stripe", "stripe"]);
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

  it("keeps going after a failed run, and stop waits for a run in progress", async () => {
    const store = ShapeStore.open(":memory:");
    const { fn } = fakeFetch(githubRoutes(() => json(204, undefined)));
    const errors: string[] = [];
    let reports = 0;
    await new Promise<void>((resolve) => {
      const stop = runEvery(
        5,
        { store, env, fetch: fn, workers: [githubWorker] },
        () => {
          if (++reports === 1) throw new Error("EACCES writing a draft");
          void stop().then(resolve);
        },
        (err) => errors.push((err as Error).message),
      );
    });
    expect(errors).toEqual(["EACCES writing a draft"]);
    expect(reports).toBe(2);

    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 20));
      return fn(input, init);
    }) as typeof globalThis.fetch;
    const fresh = ShapeStore.open(":memory:");
    const stop = runEvery(60_000, { store: fresh, env, fetch: slow, workers: [githubWorker] }, () => {});
    await stop();
    // the run that was in progress finished recording before stop resolved
    expect(fresh.endpoints()).toHaveLength(4);
    fresh.close();
    store.close();
  });
});

describe("shapi-canary CLI", () => {
  it("run refuses an unknown provider instead of running nothing", async () => {
    let err = "";
    const code = await run(["node", "shapi-canary", "run", "--once", "--provider", "stirpe", "--db", ":memory:"], { stdout: () => {}, stderr: (s) => (err += s) }, env);
    expect(code).toBe(2);
    expect(err).toContain("--provider: unknown stirpe");
  });

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

describe("more providers", () => {
  const sid = `AC${"0".repeat(32)}`;
  const keys: Env = {
    SHAPI_SLACK_BOT_TOKEN: "xoxb-test",
    SHAPI_OPENAI_API_KEY: "sk-test",
    SHAPI_ANTHROPIC_API_KEY: "sk-ant-test",
    SHAPI_TWILIO_TEST_ACCOUNT_SID: sid,
    SHAPI_TWILIO_TEST_AUTH_TOKEN: "test-token",
    SHAPI_HUBSPOT_TOKEN: "pat-test",
  };

  it("runs Slack's api.test without a token, and skips everything else until its key is set", () => {
    expect(slackWorker.probes({}).probes.map((p) => [p.id, p.auth])).toEqual([["slack:api-test", "anonymous"]]);
    for (const w of [slackWorker, openaiWorker, anthropicWorker, twilioWorker, hubspotWorker]) {
      expect(w.probes({}).skipped.length).toBeGreaterThan(0);
    }
  });

  it("builds read-only probes (and Twilio's test-credential message) from the keys", () => {
    const all = [slackWorker, openaiWorker, anthropicWorker, twilioWorker, hubspotWorker].flatMap((w) => w.probes(keys).probes);
    expect(all.map((p) => `${p.method} ${p.url}`)).toEqual([
      "GET https://slack.com/api/api.test",
      "GET https://slack.com/api/auth.test",
      "GET https://slack.com/api/conversations.list?limit=1&exclude_archived=true",
      "GET https://api.openai.com/v1/models",
      "GET https://api.anthropic.com/v1/models?limit=20",
      `POST https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      "GET https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
      "GET https://api.hubapi.com/crm/v3/pipelines/deals",
    ]);
    const twilio = all.find((p) => p.provider === "twilio")!;
    expect(twilio.body).toBe("From=%2B15005550006&To=%2B15005550006&Body=SHAPI+canary+%28Twilio+test+credentials%29");
    expect(twilio.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${sid}:test-token`).toString("base64")}` });
    expect(all.find((p) => p.provider === "anthropic")!.headers).toMatchObject({ "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" });
  });

  it("refuses a Slack token that is not a bot token, and a malformed Twilio SID", () => {
    expect(() => slackWorker.probes({ SHAPI_SLACK_BOT_TOKEN: "xoxp-user" })).toThrow(/bot token/);
    expect(() => twilioWorker.probes({ ...keys, SHAPI_TWILIO_TEST_ACCOUNT_SID: "nope" })).toThrow(/account SID/);
  });

  it("stores a shape for every new provider's probes", async () => {
    const store = ShapeStore.open(path.join(dir, "more.db"));
    const routes: Record<string, () => Response> = {
      "GET /api/api.test": () => json(200, { ok: true }),
      "GET /api/auth.test": () => json(200, { ok: true, team: "shapi", user_id: "U1" }),
      "GET /api/conversations.list": () => json(200, { ok: true, channels: [{ id: "C1", name: "general" }] }),
      "GET /v1/models": () => json(200, { object: "list", data: [{ id: "m", object: "model" }] }),
      [`POST /2010-04-01/Accounts/${sid}/Messages.json`]: () => json(201, { sid: "SM1", status: "queued" }),
      "GET /crm/v3/objects/contacts": () => json(200, { results: [{ id: "1", properties: {} }] }),
      "GET /crm/v3/pipelines/deals": () => json(200, { results: [{ id: "default", label: "Sales", stages: [] }] }),
    };
    const report = await runOnce({ store, env: { ...env, ...keys }, fetch: fakeFetch(routes).fn, providers: ["slack", "openai", "anthropic", "twilio", "hubspot"] });
    expect(report.results.filter((r) => r.error)).toEqual([]);
    expect(report.results.map((r) => `${r.id} ${r.status}`)).toEqual([
      "slack:api-test 200",
      "slack:auth-test 200",
      "slack:conversations-list 200",
      "openai:list-models 200",
      "anthropic:list-models 200",
      "twilio:create-message 201",
      "hubspot:list-contacts 200",
      "hubspot:list-deal-pipelines 200",
    ]);
    store.close();
  });
});
