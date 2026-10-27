import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiLock, loadAdvisories } from "@shapi/core";
import { createDb, migrateToLatest, upsertAdvisories, withService, type Db } from "@shapi/db";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { buildApp, loadConfig } from "../src/index";
import { MARK } from "../src/web/html";
import { landingPage } from "../src/web/landing";
import { loadAccount, withCatchDetail } from "../src/web/queries";

let pg: TestPostgres;
let db: Db;
let owner: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_web");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  await upsertAdvisories(owner, loadAdvisories(path.join(root, "advisories")), { reviewed: true, source: "repo" });
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
    expect(res.body).toContain('<a href="https://srivarshini09.github.io/YC/legal/privacy">Privacy</a>');
    // the public landing page: what SHAPI does, with numbers read from the server
    expect(res.body).toContain("Your code shouldn't break.");
    expect(res.body).toContain('id="how"');
    expect(res.body).toMatch(/<b>\d+<\/b><span>reviewed API changes<\/span>/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    await app.close();
  });

  it("serves the logo in the header and the favicons", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const home = await app.inject("/");
    expect(home.body).toContain('<a class="brand" href="/" aria-label="SHAPI home"><svg');
    expect(home.body).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    // The landing page's logo moves on hover. No style attributes and no <style> elements, so the CSP holds.
    expect(home.body).toContain('<a class="brand" href="/" aria-label="SHAPI home"><svg xmlns="http://www.w3.org/2000/svg" class="sp-logo sp-hover"');
    expect(home.body).not.toContain(" style=");
    expect(home.body).not.toContain("<style");
    // The mark (account picker, messages, welcome) is the two pieces alone: no wordmark, no bar, no <style>.
    const mark = String(MARK);
    expect(mark).toContain('viewBox="0 0 47.88 47.88"');
    expect(mark).toContain('class="sp-left"');
    expect(mark).not.toContain("sp-word");
    expect(mark).not.toContain("<style");
    const { cookie } = await signIn(app);
    expect((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body).not.toContain("<style");
    const css = await app.inject("/static/app.css");
    expect(css.body).toContain("@keyframes sp-in-left");
    expect(css.body).toContain("prefers-reduced-motion");
    // The pieces lift above the view box while they move; they show instead of being clipped.
    expect(css.body).toContain(".sp-logo { overflow: visible; }");
    const svg = await app.inject("/favicon.svg");
    expect(svg.statusCode).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.body).toContain("<svg");
    expect(svg.body).toContain("prefers-color-scheme:dark");
    const ico = await app.inject("/favicon.ico");
    expect(ico.statusCode).toBe(200);
    expect(ico.headers["content-type"]).toBe("image/x-icon");
    expect(ico.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    const touch = await app.inject("/apple-touch-icon.png");
    expect(touch.statusCode).toBe(200);
    expect(touch.rawPayload.subarray(1, 4).toString()).toBe("PNG");
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

    // one account: straight to its overview; the picker is still there under /?all
    const home = await app.inject({ url: "/", headers: { cookie } });
    expect(home.headers.location).toBe(`/a/${mine.account}`);
    const picker = await app.inject({ url: "/?all", headers: { cookie } });
    expect(picker.body).toContain(`href="/a/${mine.account}"`);
    expect(picker.body).not.toContain("rival");
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
    const home = await app.inject({ url: `/a/${mine.account}`, headers: { cookie } });
    const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(home.body)}` });
    expect(out.statusCode).toBe(302);
    expect(await withService(db, (tx) => tx.selectFrom("sessions").selectAll().execute())).toEqual([]);
    expect((await app.inject({ url: "/", headers: { cookie } })).body).toContain('href="/login"');
    expect((await app.inject({ url: "/", headers: { cookie: `${cookie}x` } })).body).toContain('href="/login"');
    await app.close();
  });
});

describe("web pages", () => {
  it("shows the account's overview, problems, fixes, repositories and API changes, escaping everything", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const account = await app.inject({ url: `/a/${mine.account}`, headers: { cookie } });
    expect(account.statusCode).toBe(200);
    expect(account.body).toContain("acme/api");
    expect(account.body).toContain("Needs your attention");
    expect(account.body).toContain('class="nav"');
    expect(account.body).not.toContain("<script");
    expect(account.body).toContain("Latest fix");
    // five monitoring entries in plain words; Deadlines lives inside API changes
    const labels = [...account.body.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Overview", "Problems", "Fixes", "Repositories", "API changes", "Settings", "Billing"]);
    const settings = await app.inject({ url: `/a/${mine.account}/settings`, headers: { cookie } });
    expect(settings.body).toContain('name="hourly" min="1" max="20" value="2"');
    for (const path of ["repositories", "findings", "fixes", "advisories", "billing"]) {
      const res = await app.inject({ url: `/a/${mine.account}/${path}`, headers: { cookie } });
      expect(res.statusCode, path).toBe(200);
      expect(res.body).not.toContain("<script");
      expect(res.body, path).not.toContain(' style="');
    }
    expect((await app.inject({ url: `/a/${mine.account}/deadlines`, headers: { cookie } })).headers.location).toBe(`/a/${mine.account}/advisories#timeline`);
    const findings = await app.inject({ url: `/a/${mine.account}/findings`, headers: { cookie } });
    expect(findings.body).toContain("src/deploy.ts:13");
    expect(findings.body).toContain('href="https://github.com/acme/api/pull/7"');
    const findingId = /\/f\/(\d+)/.exec(findings.body)![1]!;
    const finding = await app.inject({ url: `/a/${mine.account}/f/${findingId}`, headers: { cookie } });
    expect(finding.statusCode).toBe(200);
    expect(finding.body).toContain("Expected by the code");
    expect(finding.body).toContain("204 No Content");
    expect(finding.body).toContain("200 OK");
    expect(finding.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(finding.body).not.toContain("<img");
    expect(finding.body).toContain('href="https://github.com/acme/api/pull/7"');

    const repo = await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } });
    expect(repo.statusCode).toBe(200);
    expect(repo.body).toContain("https://github.com/acme/api/blob/abcdef1234567890/src/deploy.ts#L13");
    expect(repo.body).toContain('href="https://github.com/acme/api/pull/7"');
    expect(repo.body).toContain("https://github.com/acme/api/issues/4");
    expect(repo.body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(repo.body).not.toContain("<img");
    await app.close();
  });

  it("counts one problem per API change and repository, however many lines it touches", async () => {
    const scan = await owner.selectFrom("scans").select("id").where("repository_id", "=", mine.repo).executeTakeFirstOrThrow();
    await owner
      .insertInto("findings")
      .values({ account_id: mine.account, repository_id: mine.repo, scan_id: scan.id, advisory_id: "github-workflow-dispatch-204-to-200", kind: "affected", call_site: JSON.stringify({ file: "src/release.ts", line: 40 }), reasons: JSON.stringify(["checks status === 204"]) })
      .execute();
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const get = async (path: string) => (await app.inject({ url: `/a/${mine.account}${path}`, headers: { cookie } })).body;

    const overview = await get("");
    expect(overview).toContain('SHAPI found <span class="hl">1 problem</span> in your code.');
    expect(overview).toContain('<span class="label">Problems</span><span class="count bad">1</span>');
    const problems = await get("/findings");
    expect(problems).toContain("Breaks your code · 1");
    expect(problems).toContain("and 1 more place");
    expect(problems).toContain('<span class="tag bad">breaks</span>');
    expect(await get("/repositories")).toContain('<span class="tag bad">1 problem</span>');
    const findingId = /\/f\/(\d+)/.exec(problems)![1]!;
    expect(await get(`/f/${findingId}`)).toContain("Same problem, 1 other place");
    expect(await get("/advisories")).toContain("breaks 1 repo");
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

  it("connects Slack alerts: only an incoming webhook, shown masked, removable, with a test message", async () => {
    const gh = fakeGitHub();
    const slack: { url: string; body: { text: string } }[] = [];
    let slackStatus = 200;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://hooks.slack.com/")) {
        slack.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(slackStatus === 200 ? "ok" : "no_service", { status: slackStatus });
      }
      return gh.fetch(input, init);
    }) as typeof globalThis.fetch;
    const app = buildApp({ db, config, fetch });
    const { cookie } = await signIn(app);
    const pageBody = async () => (await app.inject({ url: `/a/${mine.account}/settings`, headers: { cookie } })).body;
    const csrf = csrfFrom(await pageBody());
    const form = { cookie, "content-type": "application/x-www-form-urlencoded" };
    const save = (extra: string) => app.inject({ method: "POST", url: `/a/${mine.account}/settings`, headers: form, payload: `csrf=${csrf}&hourly=2&open=10${extra}` });
    const stored = async () => (await withService(db, (tx) => tx.selectFrom("accounts").select("settings").where("id", "=", mine.account).executeTakeFirstOrThrow())).settings as { slackWebhookUrl?: string };
    const hook = "https://hooks.slack.com/services/T0001/B0001/abcdefXYZ123";

    expect((await save(`&slack=${encodeURIComponent("https://evil.example/hook")}`)).statusCode).toBe(400);
    expect((await save(`&slack=${encodeURIComponent(hook)}`)).statusCode).toBe(303);
    expect((await stored()).slackWebhookUrl).toBe(hook);
    let body = await pageBody();
    expect(body).toContain("webhook ending in <span class=\"mono\">XYZ123</span>");
    expect(body).not.toContain(hook);

    // saving other settings with the field left empty keeps the webhook
    expect((await save("")).statusCode).toBe(303);
    expect((await stored()).slackWebhookUrl).toBe(hook);

    const test = await app.inject({ method: "POST", url: `/a/${mine.account}/slack/test`, headers: form, payload: `csrf=${csrf}` });
    expect(test.headers.location).toBe(`/a/${mine.account}/settings?slack=sent`);
    expect(slack).toEqual([{ url: hook, body: expect.objectContaining({ text: expect.stringContaining("SHAPI is connected") }) }]);
    slackStatus = 404;
    const failed = await app.inject({ method: "POST", url: `/a/${mine.account}/slack/test`, headers: form, payload: `csrf=${csrf}` });
    expect(failed.headers.location).toBe(`/a/${mine.account}/settings?slack=failed`);
    body = (await app.inject({ url: `/a/${mine.account}/settings?slack=failed`, headers: { cookie } })).body;
    expect(body).toContain("Slack did not accept the test message");

    expect((await save("&slackRemove=on")).statusCode).toBe(303);
    expect((await stored()).slackWebhookUrl).toBeUndefined();
    expect(await pageBody()).not.toContain("Send a test message");
    await app.close();
  });

  it("remembers the theme in a cookie, only with the CSRF token, and never shows another account's finding", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const home = await app.inject({ url: `/a/${mine.account}`, headers: { cookie } });
    expect(home.body).not.toContain("data-theme");
    const form = { cookie, "content-type": "application/x-www-form-urlencoded" };
    expect((await app.inject({ method: "POST", url: "/theme", headers: form, payload: "csrf=nope&theme=dark" })).statusCode).toBe(403);
    const set = await app.inject({ method: "POST", url: "/theme", headers: form, payload: `csrf=${csrfFrom(home.body)}&theme=dark&back=/a/${mine.account}/findings` });
    expect(set.statusCode).toBe(303);
    expect(set.headers.location).toBe(`/a/${mine.account}/findings`);
    const theme = set.cookies.find((c) => c.name === "shapi_theme")!;
    expect(theme).toMatchObject({ value: "dark", httpOnly: true });
    const dark = await app.inject({ url: `/a/${mine.account}`, headers: { cookie: `${cookie}; shapi_theme=dark` } });
    expect(dark.body).toContain('<html lang="en" data-theme="dark">');
    const back = await app.inject({ method: "POST", url: "/theme", headers: form, payload: `csrf=${csrfFrom(home.body)}&theme=auto&back=https://evil.example/` });
    expect(back.headers.location).toBe("/");

    const rivalRepo = await owner.selectFrom("repositories").select("id").where("full_name", "=", "rival/secret").executeTakeFirstOrThrow();
    const rivalScan = await owner.insertInto("scans").values({ account_id: other.account, repository_id: rivalRepo.id, sha: "f".repeat(40), status: "succeeded" }).returning("id").executeTakeFirstOrThrow();
    const rivalFinding = await owner
      .insertInto("findings")
      .values({ account_id: other.account, repository_id: rivalRepo.id, scan_id: rivalScan.id, advisory_id: "github-workflow-dispatch-204-to-200", kind: "affected", call_site: JSON.stringify({ file: "secret.ts", line: 1 }), reasons: JSON.stringify(["rival-only-reason"]) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const res = await app.inject({ url: `/a/${mine.account}/f/${rivalFinding.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("rival-only-reason");
    await app.close();
  });

  it("welcomes a new account, shows the first scan's progress, then leads with what SHAPI found", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const overview = async () => (await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body;

    let body = await overview();
    expect(body).toContain('SHAPI found <span class="hl">1 problem</span> in your code.');
    expect(body).toContain("1 fix ready for review");
    expect(body).toContain("Review fix PR #7");
    expect(body).toContain("Get started"); // Slack is not connected yet
    expect(body).not.toContain('http-equiv="refresh"');

    await owner.deleteFrom("scans").where("account_id", "=", mine.account).execute();
    await owner.insertInto("scans").values({ account_id: mine.account, repository_id: mine.repo, sha: "b".repeat(40), status: "running" }).execute();
    body = await overview();
    expect(body).toContain("Scanning your repositories");
    expect(body).toContain('<meta http-equiv="refresh" content="10">');
    expect(body).not.toContain("SHAPI found");

    await owner.deleteFrom("repositories").where("account_id", "=", mine.account).execute();
    body = await overview();
    expect(body).toContain("Welcome to SHAPI, acme");
    expect(body).toContain('href="https://github.com/apps/shapi-test/installations/new"');
    expect(body).not.toContain(' style="');
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

describe("account pages after review", () => {
  const repair = {
    method: "recipe",
    recipeId: "status-code-accept-set",
    verifiedAt: "2026-10-23T00:00:00.000Z",
    sites: [{ file: "src/deploy.ts", line: 13, method: "POST", endpoint: "/x", status: "fixed", test: "test/shapi/a.test.ts", before: { passed: false, tests: "1 failed", output: "AssertionError: big output" }, after: { passed: true, tests: "1 passed", output: "ok" } }],
    changes: [{ file: "src/deploy.ts", kind: "modified", diff: "@@ -13 +13 @@\n-  if (res.status !== 204)\n+  if (![200, 204].includes(res.status))", truncated: false }],
  };

  it("stops showing scan progress once every first scan has failed, and shows the failure", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    await owner.deleteFrom("scans").where("account_id", "=", mine.account).execute();
    await owner.insertInto("scans").values({ account_id: mine.account, repository_id: mine.repo, sha: "c".repeat(40), status: "failed", error: "tarball download failed", finished_at: new Date() }).execute();
    const body = (await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body;
    expect(body).not.toContain("Scanning your repositories");
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).toContain("Scan failed in acme/api");
    expect(body).toContain("tarball download failed");
    await app.close();
  });

  it("loads summaries for every page, the full repair only for the latest catch, and the lock only for its repository", async () => {
    await owner.updateTable("fix_prs").set({ repair: JSON.stringify(repair) }).where("account_id", "=", mine.account).execute();
    await owner.updateTable("scans").set({ api_lock: JSON.stringify(createApiLock({ callSites: [], declared: [] }, "test")) }).where("account_id", "=", mine.account).execute();
    const data = await loadAccount(db, mine.account);
    expect(data.prs[0]!.repair!.changes).toEqual([]);
    expect(data.prs[0]!.repair!.sites[0]).toMatchObject({ status: "fixed", before: { passed: false, tests: "1 failed" }, after: { passed: true, tests: "1 passed" } });
    expect(data.prs[0]!.repair!.sites[0]!.before).not.toHaveProperty("output");
    expect(data.repos[0]!.lock).toBeUndefined();
    expect((await loadAccount(db, mine.account, { lockRepo: mine.repo })).repos[0]!.lock).toBeDefined();
    const detailed = await withCatchDetail(db, data);
    expect(detailed.prs[0]!.repair!.changes).toEqual(repair.changes);

    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const overview = (await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body;
    expect(overview).toContain("![200, 204].includes(res.status)");
    await app.close();
  });

  it("skips a malformed advisory row instead of failing every page", async () => {
    await owner.insertInto("advisories").values({ id: "broken-row", provider: "github", data: JSON.stringify({ id: "broken-row" }), reviewed: true, source: "test", modified: new Date() }).execute();
    try {
      const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
      const { cookie } = await signIn(app);
      for (const path of ["", "/advisories", "/findings", "/repositories"]) expect((await app.inject({ url: `/a/${mine.account}${path}`, headers: { cookie } })).statusCode, path).toBe(200);
      await app.close();
    } finally {
      await owner.deleteFrom("advisories").where("id", "=", "broken-row").execute();
    }
  });

  it("sends a Stripe return to the old account URL on to the billing page", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const res = await app.inject({ url: `/a/${mine.account}?billing=done&session=cs_test_1`, headers: { cookie } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/a/${mine.account}/billing?billing=done&session=cs_test_1`);
    await app.close();
  });

  it("only claims what the product does: fixes need a recipe, Python is scanned, early access is free only without billing", () => {
    const free = String(landingPage({ configured: true, advisories: 54, withFix: 11 }));
    expect(free).not.toContain("fix most changes");
    expect(free).toContain("(11 of the 54 reviewed changes have one today)");
    expect(free).toContain("scanned; fixes for TS and JS");
    expect(free).toContain("For each affected TypeScript or JavaScript call with a fix recipe");
    expect(free).toContain("Free for everyone during early access.");
    const paid = String(landingPage({ configured: true, advisories: 54, withFix: 11, billingEnabled: true }));
    expect(paid).not.toContain("early access");
  });
});
