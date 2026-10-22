import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateToLatest, withService, type Db } from "@shapi/db";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { buildApp, loadConfig } from "../src/index";

let pg: TestPostgres;
let db: Db;
let owner: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_web");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

const webApp = { clientId: "Iv1.test", clientSecret: "client-secret", publicUrl: "http://localhost:8080", sessionSecret: "x".repeat(32), appSlug: "shapi-test" };
const config = { LOG_LEVEL: "info" as const, GIT_SHA: "t", NODE_ENV: "test" as const, webApp };

/** GitHub as the sign-in flow sees it: the OAuth token exchange, the user, and their app installations. */
function fakeGitHub(opts: { installations?: number[]; failToken?: boolean } = {}) {
  const seen: { url: string; body?: unknown; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("authorization") });
    const json = (body: unknown, status = 200) => {
      const res = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      Object.defineProperty(res, "url", { value: url.href });
      return res;
    };
    if (url.href === "https://github.com/login/oauth/access_token") return opts.failToken ? json({ error: "bad_verification_code" }) : json({ access_token: "ghu_user_token", token_type: "bearer" });
    if (url.pathname === "/user") return json({ id: 99, login: "octo" });
    if (url.pathname === "/user/installations") return json({ total_count: 2, installations: (opts.installations ?? [4242, 5555]).map((id) => ({ id })) });
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

let mine: { account: string; repo: string };
let other: { account: string };

beforeEach(async () => {
  await owner.deleteFrom("accounts").execute();
  await owner.deleteFrom("sessions").execute();
  const a = await owner.insertInto("accounts").values({ github_installation_id: 4242, login: "acme", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
  const b = await owner.insertInto("accounts").values({ github_installation_id: 7777, login: "rival", type: "Organization", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
  const repo = await owner
    .insertInto("repositories")
    .values({ account_id: a.id, github_repo_id: 1, full_name: "acme/api", default_branch: "main", private: true, dashboard_issue: 4 })
    .returning("id")
    .executeTakeFirstOrThrow();
  await owner.insertInto("repositories").values({ account_id: b.id, github_repo_id: 2, full_name: "rival/secret", default_branch: "main", private: true }).execute();
  const scan = await owner
    .insertInto("scans")
    .values({ account_id: a.id, repository_id: repo.id, sha: "abcdef1234567890", status: "succeeded", finished_at: new Date() })
    .returning("id")
    .executeTakeFirstOrThrow();
  await owner
    .insertInto("findings")
    .values({
      account_id: a.id,
      repository_id: repo.id,
      scan_id: scan.id,
      advisory_id: "github-workflow-dispatch-204-to-200",
      kind: "affected",
      call_site: JSON.stringify({ file: "src/deploy.ts", line: 13 }),
      reasons: JSON.stringify(["checks status === 204 <img src=x onerror=alert(1)>"]),
    })
    .execute();
  await owner
    .insertInto("fix_prs")
    .values({ account_id: a.id, repository_id: repo.id, advisory_id: "github-workflow-dispatch-204-to-200", branch: "shapi/x", number: 7, url: "https://github.com/acme/api/pull/7", state: "open", updated_at: new Date() })
    .execute();
  mine = { account: a.id, repo: repo.id };
  other = { account: b.id };
});

const cookieHeader = (cookies: { name: string; value: string }[]) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");

/** Sign in through the real flow: /login sets the state cookie, the callback exchanges the code. */
async function signIn(app: ReturnType<typeof buildApp>) {
  const login = await app.inject("/login");
  const state = new URL(String(login.headers.location)).searchParams.get("state")!;
  const callback = await app.inject({ url: `/auth/github/callback?code=c0de&state=${state}`, headers: { cookie: cookieHeader(login.cookies) } });
  const session = callback.cookies.find((c) => c.name === "shapi_session")!;
  return { callback, cookie: `shapi_session=${session.value}` };
}

const csrfFrom = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)![1]!;

describe("config", () => {
  it("enables sign-in with the OAuth client, and requires a strong session secret in production", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).webApp).toBeUndefined();
    const c = loadConfig({ DATABASE_URL: "postgres://x", SHAPI_GITHUB_CLIENT_ID: "id", SHAPI_GITHUB_CLIENT_SECRET: "s", SHAPI_PUBLIC_URL: "https://app.example.com/" });
    expect(c.webApp).toMatchObject({ clientId: "id", publicUrl: "https://app.example.com" });
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", NODE_ENV: "production", SHAPI_SHAPE_SECRET: "s", SHAPI_GITHUB_CLIENT_ID: "id", SHAPI_GITHUB_CLIENT_SECRET: "s", SHAPI_SESSION_SECRET: "short" })).toThrow(/SHAPI_SESSION_SECRET/);
  });
});

describe("web sign-in", () => {
  it("shows a sign-in page with strict security headers and no scripts", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const res = await app.inject("/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/login"');
    expect(res.body).toContain("https://github.com/apps/shapi-test/installations/new");
    expect(res.body).not.toContain("<script");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    await app.close();
  });

  it("signs in through GitHub, keeps no user token, and stores only a hash of the session token", async () => {
    const gh = fakeGitHub();
    const app = buildApp({ db, config, fetch: gh.fetch });
    const login = await app.inject("/login");
    const location = new URL(String(login.headers.location));
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.test");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:8080/auth/github/callback");

    const { callback, cookie } = await signIn(app);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    const sessionCookie = callback.cookies.find((c) => c.name === "shapi_session")!;
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(gh.seen.find((s) => s.url.endsWith("/user"))?.auth).toBe("token ghu_user_token");

    const rows = await withService(db, (tx) => tx.selectFrom("sessions").selectAll().execute());
    expect(rows).toHaveLength(1);
    const token = decodeURIComponent(sessionCookie.value).split(".")[0]!;
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("ghu_user_token");
    expect(rows[0]).toMatchObject({ login: "octo", installation_ids: ["4242", "5555"] });

    const home = await app.inject({ url: "/", headers: { cookie } });
    expect(home.body).toContain(`href="/a/${mine.account}"`);
    expect(home.body).not.toContain("rival");
    await app.close();
  });

  it("rejects a callback without the matching state, and a failed token exchange", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub({ failToken: true }).fetch });
    expect((await app.inject("/auth/github/callback?code=c&state=forged")).statusCode).toBe(400);
    const login = await app.inject("/login");
    const state = new URL(String(login.headers.location)).searchParams.get("state")!;
    const res = await app.inject({ url: `/auth/github/callback?code=c&state=${state}`, headers: { cookie: cookieHeader(login.cookies) } });
    expect(res.statusCode).toBe(502);
    expect(await withService(db, (tx) => tx.selectFrom("sessions").selectAll().execute())).toEqual([]);
    await app.close();
  });

  it("signs out: the session is deleted, and a tampered cookie counts as signed out", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const home = await app.inject({ url: "/", headers: { cookie } });
    const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(home.body)}` });
    expect(out.statusCode).toBe(302);
    expect(await withService(db, (tx) => tx.selectFrom("sessions").selectAll().execute())).toEqual([]);
    expect((await app.inject({ url: "/", headers: { cookie } })).body).toContain('href="/login"');
    expect((await app.inject({ url: "/", headers: { cookie: `${cookie}x` } })).body).toContain('href="/login"');
    await app.close();
  });
});

describe("web pages", () => {
  it("shows the account's repositories, findings and fix PRs, escaping everything", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const account = await app.inject({ url: `/a/${mine.account}`, headers: { cookie } });
    expect(account.statusCode).toBe(200);
    expect(account.body).toContain("acme/api");
    expect(account.body).toContain("1 affected");
    expect(account.body).toContain('name="hourly" min="1" max="20" value="2"');

    const repo = await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } });
    expect(repo.statusCode).toBe(200);
    expect(repo.body).toContain("https://github.com/acme/api/blob/abcdef1234567890/src/deploy.ts#L13");
    expect(repo.body).toContain('href="https://github.com/acme/api/pull/7"');
    expect(repo.body).toContain("https://github.com/acme/api/issues/4");
    expect(repo.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(repo.body).not.toContain("<img");
    await app.close();
  });

  it("never shows another account: not by id, not through a repository id", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    expect((await app.inject({ url: `/a/${other.account}`, headers: { cookie } })).statusCode).toBe(404);
    const rival = await withService(db, (tx) => tx.selectFrom("repositories").select("id").where("full_name", "=", "rival/secret").executeTakeFirstOrThrow());
    const res = await app.inject({ url: `/a/${mine.account}/r/${rival.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("rival/secret");
    expect((await app.inject({ url: `/a/${mine.account}` })).headers.location).toBe("/login");
    await app.close();
  });

  it("saves settings only with the session's CSRF token and valid values", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const csrf = csrfFrom((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body);
    const post = (payload: string) =>
      app.inject({ method: "POST", url: `/a/${mine.account}/settings`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload });

    expect((await post("csrf=wrong&hourly=5&open=10")).statusCode).toBe(403);
    expect((await post(`csrf=${csrf}&hourly=99&open=10`)).statusCode).toBe(400);
    const ok = await post(`csrf=${csrf}&hourly=5&open=12&failOnAffected=on`);
    expect(ok.statusCode).toBe(303);
    const saved = await withService(db, (tx) => tx.selectFrom("accounts").select("settings").where("id", "=", mine.account).executeTakeFirstOrThrow());
    expect(saved.settings).toEqual({ prLimits: { hourly: 5, open: 12 }, failOnAffected: true, llmFixes: false });
    await app.close();
  });

  it("pauses and resumes a repository from the web app, separately from the dashboard checkbox", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const page = await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } });
    const pause = () =>
      app.inject({ method: "POST", url: `/a/${mine.account}/r/${mine.repo}/pause`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(page.body)}` });
    const settings = async () => (await withService(db, (tx) => tx.selectFrom("repositories").select("settings").where("id", "=", mine.repo).executeTakeFirstOrThrow())).settings;
    await owner.updateTable("repositories").set({ settings: JSON.stringify({ paused: true }) }).where("id", "=", mine.repo).execute();

    expect((await pause()).statusCode).toBe(303);
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: true });
    expect((await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } })).body).toContain("Resume SHAPI on this repository");
    await pause();
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: false });
    await app.close();
  });
});
