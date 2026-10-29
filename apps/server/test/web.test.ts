import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiLock, loadAdvisories } from "@shapi/core";
import { createDb, migrateToLatest, upsertAdvisories, withService, type Db } from "@shapi/db";
import { fakeUserGitHub, type FakeUserInstallation, type FakeUserRepository } from "../../../test-utils/fake-github";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { buildApp, loadConfig } from "../src/index";
import { MARK } from "../src/web/html";
import { landingPage } from "../src/web/landing";
import { healthOf, loadAccount, withCatchDetail } from "../src/web/queries";
import { sameToken } from "../src/web/auth";
import { dueTag, fileUrl } from "../src/web/views";

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

/** The organization acme, as GitHub lists its installation. */
const ACME = { id: 500, login: "acme", type: "Organization" as const };

/**
 * GitHub as the sign-in flow sees it. By default the user (octo, id 99) can access installation 4242
 * (acme), where they are admin on its one repository, and installation 5555, which SHAPI does not know.
 */
function fakeGitHub(opts: { installations?: FakeUserInstallation[]; failToken?: boolean } = {}) {
  const installations = opts.installations ?? [
    { id: 4242, account: ACME, repositories: [{ id: 1, full_name: "acme/api", permissions: { admin: true, push: true } }] },
    { id: 5555, account: { id: 600, login: "other", type: "Organization" } },
  ];
  return fakeUserGitHub({ user: { id: 99, login: "octo" }, installations, failToken: opts.failToken });
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
    expect(res.body).toContain('<a href="https://shapi.dev/legal/privacy">Privacy</a>');
    // the public landing page: what SHAPI does, with numbers read from the server
    expect(res.body).toContain("keeps working.");
    expect(res.body).toContain('id="how"');
    expect(res.body).toMatch(/<b>\d+<\/b><span>reviewed API changes<\/span>/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    await app.close();
  });

  it("sends pages on Fly's default hostname to the public URL, but not health checks", async () => {
    const app = buildApp({ db, config: { ...config, webApp: { ...webApp, publicUrl: "https://app.shapi.dev" } }, fetch: fakeGitHub().fetch });
    const res = await app.inject({ url: "/login?next=%2Fa%2F1", headers: { host: "shapi-app.fly.dev" } });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe("https://app.shapi.dev/login?next=%2Fa%2F1");
    expect((await app.inject({ url: "/healthz", headers: { host: "shapi-app.fly.dev" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/", headers: { host: "app.shapi.dev" } })).statusCode).toBe(200);
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
    // What the user can do in each installation, read from GitHub with their token.
    expect(rows[0]!.access).toEqual({ "4242": { read: ["1"], push: ["1"], admin: ["1"], owner: false }, "5555": { read: [], push: [], admin: [], owner: false } });
    expect(gh.seen.find((s) => s.url.includes("/user/installations/4242/repositories"))?.auth).toBe("token ghu_user_token");

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
    expect(overview).toContain("1 problem needs you.");
    expect(overview).toContain("SHAPI found 1 problem in your code");
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

  it("offers Claude fixes only when the server has an Anthropic key, and keeps the saved choice without one", async () => {
    const form = (cookie: string) => ({ cookie, "content-type": "application/x-www-form-urlencoded" });
    const saved = async () => (await withService(db, (tx) => tx.selectFrom("accounts").select("settings").where("id", "=", mine.account).executeTakeFirstOrThrow())).settings;

    const withKey = buildApp({ db, config: { ...config, ANTHROPIC_API_KEY: "sk-ant-test" }, fetch: fakeGitHub().fetch });
    let session = await signIn(withKey);
    let body = (await withKey.inject({ url: `/a/${mine.account}/settings`, headers: { cookie: session.cookie } })).body;
    expect(body).toContain('name="llmFixes"');
    await withKey.inject({ method: "POST", url: `/a/${mine.account}/settings`, headers: form(session.cookie), payload: `csrf=${csrfFrom(body)}&hourly=2&open=10&llmFixes=on` });
    expect(await saved()).toMatchObject({ llmFixes: true });
    await withKey.close();

    const noKey = buildApp({ db, config, fetch: fakeGitHub().fetch });
    session = await signIn(noKey);
    body = (await noKey.inject({ url: `/a/${mine.account}/settings`, headers: { cookie: session.cookie } })).body;
    expect(body).not.toContain('name="llmFixes"');
    expect(body).not.toContain("Use Claude");
    // Saving the form (which has no Claude box) keeps the opt-in for when a key is added.
    await noKey.inject({ method: "POST", url: `/a/${mine.account}/settings`, headers: form(session.cookie), payload: `csrf=${csrfFrom(body)}&hourly=3&open=10` });
    expect(await saved()).toMatchObject({ prLimits: { hourly: 3, open: 10 }, llmFixes: true });
    await noKey.close();
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
    expect(body).toContain("1 problem needs you.");
    expect(body).toContain("SHAPI found 1 problem in your code");
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
    const queued: [string, string][] = [];
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch, enqueueFix: async (scanId, repo) => void queued.push([scanId, repo]) });
    const scan = await owner.updateTable("scans").set({ api_lock: JSON.stringify({ callSites: [] }) }).where("repository_id", "=", mine.repo).returning("id").executeTakeFirstOrThrow();
    const { cookie } = await signIn(app);
    const page = await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } });
    expect(page.body).toContain('<input type="hidden" name="paused" value="1"><button type="submit">Pause SHAPI on this repository</button>');
    const pause = (paused: string) =>
      app.inject({ method: "POST", url: `/a/${mine.account}/r/${mine.repo}/pause`, headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: `csrf=${csrfFrom(page.body)}&paused=${paused}` });
    const settings = async () => (await withService(db, (tx) => tx.selectFrom("repositories").select("settings").where("id", "=", mine.repo).executeTakeFirstOrThrow())).settings;
    await owner.updateTable("repositories").set({ settings: JSON.stringify({ paused: true }) }).where("id", "=", mine.repo).execute();

    expect((await pause("1")).statusCode).toBe(303);
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: true });
    // The form names the state it wants: a second click (or a stale page) keeps the repository paused.
    expect((await pause("1")).statusCode).toBe(303);
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: true });
    expect(queued).toEqual([]);
    const paused = (await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } })).body;
    expect(paused).toContain('<input type="hidden" name="paused" value="0"><button type="submit">Resume SHAPI on this repository</button>');
    // A form without a state (a page from before this change) changes nothing.
    expect((await pause("")).statusCode).toBe(403);
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: true });
    await pause("0");
    expect(await settings()).toEqual({ paused: true, pausedFromWeb: false });
    // Resumed: the fixes that waited are delivered from the latest scan now.
    expect(queued).toEqual([[scan.id, mine.repo]]);
    await app.close();
  });
});

describe("not found and robots", () => {
  it("shows a page to people for unknown addresses, and JSON to everything else", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const page = await app.inject({ url: "/no/such/page", headers: { accept: "text/html,application/xhtml+xml" } });
    expect(page.statusCode).toBe(404);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toContain("Page not found");
    expect(page.body).toContain('href="/"');
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    const api = await app.inject({ method: "POST", url: "/no/such/hook", payload: {} });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: "Not Found", statusCode: 404 });
    expect((await app.inject({ url: "/no/such/page" })).headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("serves robots.txt that keeps sign-in and account pages out of search engines", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const res = await app.inject({ url: "/robots.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.body).toBe("User-agent: *\nDisallow: /a/\nDisallow: /auth/\nDisallow: /login\n");
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
    const data = await loadAccount(db, mine.account, { readable: ["1"] });
    expect(data.prs[0]!.repair!.changes).toEqual([]);
    expect(data.prs[0]!.repair!.sites[0]).toMatchObject({ status: "fixed", before: { passed: false, tests: "1 failed" }, after: { passed: true, tests: "1 passed" } });
    expect(data.prs[0]!.repair!.sites[0]!.before).not.toHaveProperty("output");
    expect(data.repos[0]!.lock).toBeUndefined();
    expect((await loadAccount(db, mine.account, { readable: ["1"], lockRepo: mine.repo })).repos[0]!.lock).toBeDefined();
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

describe("who sees and manages what", () => {
  const form = (cookie: string) => ({ cookie, "content-type": "application/x-www-form-urlencoded" });
  const post = (app: ReturnType<typeof buildApp>, url: string, cookie: string, payload: string) => app.inject({ method: "POST", url, headers: form(cookie), payload });
  /** A second private repository of acme, with a problem and a fix PR of its own. */
  async function seedHidden() {
    const repo = await owner.insertInto("repositories").values({ account_id: mine.account, github_repo_id: 3, full_name: "acme/hidden", default_branch: "main", private: true }).returning("id").executeTakeFirstOrThrow();
    const scan = await owner.insertInto("scans").values({ account_id: mine.account, repository_id: repo.id, sha: "d".repeat(40), status: "succeeded", finished_at: new Date() }).returning("id").executeTakeFirstOrThrow();
    const finding = await owner
      .insertInto("findings")
      .values({ account_id: mine.account, repository_id: repo.id, scan_id: scan.id, advisory_id: "github-workflow-dispatch-204-to-200", kind: "affected", call_site: JSON.stringify({ file: "src/payments.ts", line: 7 }), reasons: JSON.stringify(["hidden-only-reason"]) })
      .returning("id")
      .executeTakeFirstOrThrow();
    await owner
      .insertInto("fix_prs")
      .values({ account_id: mine.account, repository_id: repo.id, advisory_id: "github-workflow-dispatch-204-to-200", branch: "shapi/hidden", number: 9, url: "https://github.com/acme/hidden/pull/9", state: "open", updated_at: new Date() })
      .execute();
    return { repo: repo.id, finding: finding.id };
  }
  const acmeWith = (repositories: FakeUserRepository[]) => fakeGitHub({ installations: [{ id: 4242, account: ACME, repositories }] });
  const accountSettings = async () => (await owner.selectFrom("accounts").select("settings").where("id", "=", mine.account).executeTakeFirstOrThrow()).settings;
  const repoSettings = async () => (await owner.selectFrom("repositories").select("settings").where("id", "=", mine.repo).executeTakeFirstOrThrow()).settings;

  it("shows a collaborator on one repository only that repository, everywhere", async () => {
    const hidden = await seedHidden();
    const app = buildApp({ db, config, fetch: acmeWith([{ id: 1, full_name: "acme/api" }]).fetch });
    const { cookie } = await signIn(app);
    const get = (path: string) => app.inject({ url: `/a/${mine.account}${path}`, headers: { cookie } });
    for (const path of ["", "/repositories", "/findings", "/findings?kind=works", "/fixes", "/fixes?state=open", "/advisories"]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.body, path).not.toContain("acme/hidden");
      expect(res.body, path).not.toContain("hidden-only-reason");
      expect(res.body, path).not.toContain("src/payments.ts");
    }
    const overview = (await get("")).body;
    expect(overview).toContain("acme/api");
    // Counts are this user's: one problem and one fix to review, not two.
    expect(overview).toContain('<span class="label">Problems</span><span class="count bad">1</span>');
    expect(overview).toContain("1 fix ready for review");
    expect((await get("/advisories")).body).toContain("breaks 1 repo");
    // The other repository's pages are missing, like another account's.
    const repo = await get(`/r/${hidden.repo}`);
    expect(repo.statusCode).toBe(404);
    expect(repo.body).not.toContain("acme/hidden");
    const finding = await get(`/f/${hidden.finding}`);
    expect(finding.statusCode).toBe(404);
    expect(finding.body).not.toContain("hidden-only-reason");
    expect((await post(app, `/a/${mine.account}/r/${hidden.repo}/pause`, cookie, `csrf=${csrfFrom(overview)}&paused=1`)).statusCode).toBe(404);
    await app.close();
  });

  it("pauses by changing only its own key, so a dashboard edit saved at the same time is kept", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const csrf = csrfFrom((await app.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } })).body);
    // Another writer (a dashboard edit) holds the row while the pause arrives.
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const released = new Promise<void>((r) => (release = r));
    const writer = owner.transaction().execute(async (tx) => {
      await tx.updateTable("repositories").set({ settings: JSON.stringify({ createNow: ["github-workflow-dispatch-204-to-200"] }) }).where("id", "=", mine.repo).execute();
      locked();
      await released;
    });
    await isLocked;
    const pausing = post(app, `/a/${mine.account}/r/${mine.repo}/pause`, cookie, `csrf=${csrf}&paused=1`);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await writer;
    expect((await pausing).statusCode).toBe(303);
    expect(await repoSettings()).toEqual({ createNow: ["github-workflow-dispatch-204-to-200"], pausedFromWeb: true });
    await app.close();
  });

  it("lets only users who can push pause a repository", async () => {
    const readOnly = buildApp({ db, config, fetch: acmeWith([{ id: 1, full_name: "acme/api" }]).fetch });
    let { cookie } = await signIn(readOnly);
    const page = await readOnly.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("Pause SHAPI on this repository");
    const denied = await post(readOnly, `/a/${mine.account}/r/${mine.repo}/pause`, cookie, `csrf=${csrfFrom(page.body)}&paused=1`);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("write access");
    expect(await repoSettings()).toEqual({});
    await readOnly.close();

    const pusher = buildApp({ db, config, fetch: acmeWith([{ id: 1, full_name: "acme/api", permissions: { push: true } }]).fetch });
    ({ cookie } = await signIn(pusher));
    const csrf = csrfFrom((await pusher.inject({ url: `/a/${mine.account}/r/${mine.repo}`, headers: { cookie } })).body);
    expect((await post(pusher, `/a/${mine.account}/r/${mine.repo}/pause`, cookie, `csrf=${csrf}&paused=1`)).statusCode).toBe(303);
    expect(await repoSettings()).toEqual({ pausedFromWeb: true });
    await pusher.close();
  });

  it("keeps settings, Slack and billing to account admins: not an admin of only some repositories", async () => {
    await seedHidden();
    await owner.updateTable("accounts").set({ settings: JSON.stringify({ slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/secretXYZ123" }) }).where("id", "=", mine.account).execute();
    const before = await accountSettings();
    // Admin on acme/api, but only push on acme/hidden.
    const app = buildApp({ db, config, fetch: acmeWith([{ id: 1, full_name: "acme/api", permissions: { admin: true, push: true } }, { id: 3, full_name: "acme/hidden", permissions: { push: true } }]).fetch });
    const { cookie } = await signIn(app);
    const overview = await app.inject({ url: `/a/${mine.account}`, headers: { cookie } });
    const labels = [...overview.body.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Overview", "Problems", "Fixes", "Repositories", "API changes"]);
    expect(overview.body).not.toContain(`href="/a/${mine.account}/settings"`);
    expect(overview.body).not.toContain(`href="/a/${mine.account}/billing"`);
    const csrf = csrfFrom(overview.body);
    for (const path of ["settings", "billing"]) {
      const res = await app.inject({ url: `/a/${mine.account}/${path}`, headers: { cookie } });
      expect(res.statusCode, path).toBe(403);
      expect(res.body, path).toContain("Account admins only");
      expect(res.body, path).not.toContain("XYZ123");
    }
    expect((await post(app, `/a/${mine.account}/settings`, cookie, `csrf=${csrf}&hourly=5&open=10&slack=${encodeURIComponent("https://hooks.slack.com/services/T9/B9/attacker")}`)).statusCode).toBe(403);
    expect((await post(app, `/a/${mine.account}/slack/test`, cookie, `csrf=${csrf}`)).statusCode).toBe(403);
    for (const action of ["checkout", "portal", "add-repos"]) expect((await post(app, `/a/${mine.account}/billing/${action}`, cookie, `csrf=${csrf}`)).statusCode, action).toBe(403);
    expect(await accountSettings()).toEqual(before);
    await app.close();
  });

  it("lets an organization admin (admin on every covered repository) change settings", async () => {
    await seedHidden();
    const app = buildApp({ db, config, fetch: acmeWith([{ id: 1, permissions: { admin: true } }, { id: 3, permissions: { admin: true } }]).fetch });
    const { cookie } = await signIn(app);
    const page = await app.inject({ url: `/a/${mine.account}/settings`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<span class="label">Settings</span>');
    expect(page.body).toContain('<span class="label">Billing</span>');
    expect((await app.inject({ url: `/a/${mine.account}/billing`, headers: { cookie } })).statusCode).toBe(200);
    expect((await post(app, `/a/${mine.account}/settings`, cookie, `csrf=${csrfFrom(page.body)}&hourly=4&open=10`)).statusCode).toBe(303);
    expect(await accountSettings()).toMatchObject({ prLimits: { hourly: 4, open: 10 } });
    await app.close();
  });

  it("makes the owner of a personal account its admin, and nobody else", async () => {
    const personal = await owner.insertInto("accounts").values({ github_installation_id: 8888, login: "octo", type: "User", settings: JSON.stringify({}) }).returning("id").executeTakeFirstOrThrow();
    await owner.insertInto("repositories").values({ account_id: personal.id, github_repo_id: 10, full_name: "octo/tool", default_branch: "main", private: true }).execute();
    // octo (id 99) owns the account: its settings are theirs.
    const own = buildApp({ db, config, fetch: fakeGitHub({ installations: [{ id: 8888, account: { id: 99, login: "octo", type: "User" }, repositories: [{ id: 10, permissions: { admin: true, push: true } }] }] }).fetch });
    let { cookie } = await signIn(own);
    const page = await own.inject({ url: `/a/${personal.id}/settings`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect((await post(own, `/a/${personal.id}/settings`, cookie, `csrf=${csrfFrom(page.body)}&hourly=3&open=10`)).statusCode).toBe(303);
    await own.close();

    // A collaborator with write access to someone else's personal repository.
    const guest = buildApp({ db, config, fetch: fakeGitHub({ installations: [{ id: 8888, account: { id: 77, login: "octo", type: "User" }, repositories: [{ id: 10, permissions: { push: true } }] }] }).fetch });
    ({ cookie } = await signIn(guest));
    expect((await guest.inject({ url: `/a/${personal.id}`, headers: { cookie } })).body).toContain("octo/tool");
    expect((await guest.inject({ url: `/a/${personal.id}/settings`, headers: { cookie } })).statusCode).toBe(403);
    expect((await guest.inject({ url: `/a/${personal.id}/billing`, headers: { cookie } })).statusCode).toBe(403);
    await guest.close();
  });
});

describe("web app review fixes", () => {
  const form = (cookie: string) => ({ cookie, "content-type": "application/x-www-form-urlencoded" });

  it("answers a CSRF token with non-ASCII characters with 403, not 500", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    // As long as the real token in characters, but longer in bytes.
    const res = await app.inject({ method: "POST", url: "/theme", headers: form(cookie), payload: `csrf=${encodeURIComponent(`é${"a".repeat(42)}`)}&theme=dark` });
    expect(res.statusCode).toBe(403);
    expect(sameToken(`é${"a".repeat(42)}`, "a".repeat(43))).toBe(false);
    await app.close();
  });

  it("answers ids beyond Postgres' bigint with 404", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const csrf = csrfFrom((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body);
    expect((await app.inject({ url: `/a/${mine.account}/f/99999999999999999999`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/a/${mine.account}/r/99999999999999999999`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/a/${mine.account}/r/99999999999999999999/pause`, headers: form(cookie), payload: `csrf=${csrf}&paused=1` })).statusCode).toBe(404);
    await app.close();
  });

  it("shows no notice for query values that name built-in object keys", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    for (const url of ["/settings?slack=constructor", "/settings?slack=__proto__", "/billing?billing=toString", "/billing?billing=constructor"]) {
      const res = await app.inject({ url: `/a/${mine.account}${url}`, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain('class="notice"');
      expect(res.body, url).not.toContain("native code");
    }
    await app.close();
  });

  it("shows a finding whose advisory row is malformed or not reviewed as no longer listed", async () => {
    const scan = await owner.selectFrom("scans").select("id").where("repository_id", "=", mine.repo).executeTakeFirstOrThrow();
    const valid = (await owner.selectFrom("advisories").select("data").where("id", "=", "github-workflow-dispatch-204-to-200").executeTakeFirstOrThrow()).data as Record<string, unknown>;
    await owner.insertInto("advisories").values({ id: "broken-advisory", provider: "github", data: JSON.stringify({ id: "broken-advisory" }), reviewed: true, source: "test", modified: new Date() }).execute();
    await owner.insertInto("advisories").values({ id: "draft-advisory", provider: "github", data: JSON.stringify({ ...valid, id: "draft-advisory", title: "Draft title" }), reviewed: false, source: "test", modified: new Date() }).execute();
    try {
      const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
      const { cookie } = await signIn(app);
      for (const advisory of ["broken-advisory", "draft-advisory"]) {
        const f = await owner
          .insertInto("findings")
          .values({ account_id: mine.account, repository_id: mine.repo, scan_id: scan.id, advisory_id: advisory, kind: "affected", call_site: JSON.stringify({ file: "src/x.ts", line: 1 }), reasons: JSON.stringify(["x"]) })
          .returning("id")
          .executeTakeFirstOrThrow();
        const res = await app.inject({ url: `/a/${mine.account}/f/${f.id}`, headers: { cookie } });
        expect(res.statusCode, advisory).toBe(200);
        expect(res.body, advisory).toContain("is no longer in SHAPI's list");
        expect(res.body, advisory).not.toContain("Draft title");
      }
      await app.close();
    } finally {
      await owner.deleteFrom("advisories").where("id", "in", ["broken-advisory", "draft-advisory"]).execute();
    }
  });

  it("says a change is fixed by hand only when the fix job cannot fix it: no recipe SHAPI has, and no Claude", async () => {
    const scan = await owner.selectFrom("scans").select("id").where("repository_id", "=", mine.repo).executeTakeFirstOrThrow();
    // Only this problem: a change with no recipe, and no fix PR yet.
    await owner.deleteFrom("findings").where("repository_id", "=", mine.repo).execute();
    await owner.deleteFrom("fix_prs").where("repository_id", "=", mine.repo).execute();
    const f = await owner
      .insertInto("findings")
      .values({ account_id: mine.account, repository_id: mine.repo, scan_id: scan.id, advisory_id: "google-custom-search-json-api-shutdown", kind: "affected", call_site: JSON.stringify({ file: "src/search.ts", line: 3 }), reasons: JSON.stringify(["calls the API"]) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const setLlm = (on: boolean) => owner.updateTable("accounts").set({ settings: JSON.stringify({ llmFixes: on }) }).where("id", "=", mine.account).execute();

    // No key on the server: by hand, and the finding page does not point to a Claude option Settings does not offer.
    await setLlm(true);
    let app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    let { cookie } = await signIn(app);
    expect((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body).toContain("no automatic fix for this change");
    let finding = (await app.inject({ url: `/a/${mine.account}/f/${f.id}`, headers: { cookie } })).body;
    expect(finding).toContain("Manual fix.");
    expect(finding).not.toContain("Claude fixes");
    await app.close();

    // A key, and the account opted in: the fix job asks Claude, so the fix is on the way.
    app = buildApp({ db, config: { ...config, ANTHROPIC_API_KEY: "sk-ant-test" }, fetch: fakeGitHub().fetch });
    ({ cookie } = await signIn(app));
    const overview = (await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body;
    expect(overview).not.toContain("no automatic fix");
    expect(overview).toContain("Fix on the way");
    expect((await app.inject({ url: `/a/${mine.account}/f/${f.id}`, headers: { cookie } })).body).toContain("The fix is on the way");
    expect((await app.inject({ url: `/a/${mine.account}/findings`, headers: { cookie } })).body).toContain("on the way");

    // A key but no opt-in: by hand, with the way to turn Claude on.
    await setLlm(false);
    finding = (await app.inject({ url: `/a/${mine.account}/f/${f.id}`, headers: { cookie } })).body;
    expect(finding).toContain("Manual fix.");
    expect(finding).toContain(`turns on Claude fixes in <a href="/a/${mine.account}/settings">Settings</a>`);
    await app.close();
  });

  it("treats an advisory whose recipe this build lacks as a fix by hand", async () => {
    const valid = (await owner.selectFrom("advisories").select("data").where("id", "=", "github-workflow-dispatch-204-to-200").executeTakeFirstOrThrow()).data as Record<string, unknown>;
    await owner.insertInto("advisories").values({ id: "future-recipe", provider: "github", data: JSON.stringify({ ...valid, id: "future-recipe", title: "Needs a future recipe", recipeId: "no-such-recipe" }), reviewed: true, source: "test", modified: new Date() }).execute();
    try {
      const scan = await owner.selectFrom("scans").select("id").where("repository_id", "=", mine.repo).executeTakeFirstOrThrow();
      await owner
        .insertInto("findings")
        .values({ account_id: mine.account, repository_id: mine.repo, scan_id: scan.id, advisory_id: "future-recipe", kind: "affected", call_site: JSON.stringify({ file: "src/y.ts", line: 2 }), reasons: JSON.stringify(["y"]) })
        .execute();
      const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
      const { cookie } = await signIn(app);
      expect((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body).toContain("Fix by hand: Needs a future recipe");
      const advisories = (await app.inject({ url: `/a/${mine.account}/advisories?advisory=future-recipe`, headers: { cookie } })).body;
      expect(advisories).toMatch(/Needs a future recipe<\/b>[\s\S]*?<span class="tag ">by hand<\/span>/);
      await app.close();
    } finally {
      await owner.deleteFrom("advisories").where("id", "=", "future-recipe").execute();
    }
  });

  it("signs out only on a form from this site", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const forged = await app.inject({ method: "POST", url: "/logout", headers: form(cookie), payload: "" });
    expect(forged.statusCode).toBe(302);
    expect(forged.cookies.find((c) => c.name === "shapi_session")).toBeUndefined();
    expect(await withService(db, (tx) => tx.selectFrom("sessions").selectAll().execute())).toHaveLength(1);
    // No session cookie at all, as in a cross-site post: nothing is cleared either.
    expect((await app.inject({ method: "POST", url: "/logout", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "" })).cookies).toEqual([]);
    await app.close();
  });

  it("encodes each segment of a file path in GitHub links", () => {
    expect(fileUrl("o/r", "s", "src/#a.ts", 3)).toBe("https://github.com/o/r/blob/s/src/%23a.ts#L3");
    expect(fileUrl("o/r", "s", "src/100%.ts")).toBe("https://github.com/o/r/blob/s/src/100%25.ts");
    expect(fileUrl("o/r", "s", "a?b.py", 1)).toBe("https://github.com/o/r/blob/s/a%3Fb.py#L1");
  });

  it("says when sign-in was cancelled on GitHub", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const login = await app.inject("/login");
    const state = new URL(String(login.headers.location)).searchParams.get("state")!;
    const res = await app.inject({ url: `/auth/github/callback?error=access_denied&state=${state}`, headers: { cookie: cookieHeader(login.cookies) } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Sign-in cancelled");
    await app.close();
  });

  it("treats a Slack field of only spaces as empty, and refuses a return path a header cannot carry", async () => {
    const app = buildApp({ db, config, fetch: fakeGitHub().fetch });
    const { cookie } = await signIn(app);
    const csrf = csrfFrom((await app.inject({ url: `/a/${mine.account}`, headers: { cookie } })).body);
    expect((await app.inject({ method: "POST", url: `/a/${mine.account}/settings`, headers: form(cookie), payload: `csrf=${csrf}&hourly=2&open=10&slack=%20%20` })).statusCode).toBe(303);
    for (const back of ["/a%01b", "/caf%C3%A9", "/%E2%9C%93"]) {
      const res = await app.inject({ method: "POST", url: "/theme", headers: form(cookie), payload: `csrf=${csrf}&theme=dark&back=${back}` });
      expect(res.statusCode, back).toBe(303);
      expect(res.headers.location, back).toBe("/");
    }
    await app.close();
  });

  it("says today for a change that takes effect today, not in 0 days", () => {
    expect(String(dueTag(0))).toContain(">today<");
    expect(String(dueTag(1))).toContain(">in 1 day<");
  });

  it("says the score appears after the first scan, which installing starts", async () => {
    await owner.deleteFrom("scans").where("account_id", "=", mine.account).execute();
    const data = await loadAccount(db, mine.account, { readable: ["1"] });
    expect(healthOf(data).why).toBe("The score appears after the first scan.");
  });
});
