import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { loadAdvisories, type Finding, type LockedCallSite } from "@shapi/core";
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  SCAN_PERMISSIONS,
  appManifest,
  appOctokit,
  checkRunOutput,
  completeCheckRun,
  convertManifestCode,
  installationOctokit,
  listInstallationRepositories,
  listRecentDeliveries,
  normalizePrivateKey,
  planRedeliveries,
  scopedInstallationToken,
  signWebhook,
  startCheckRun,
  verifyWebhookSignature,
  type HookDelivery,
} from "@shapi/github-app";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const creds = { appId: "123", privateKey };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake GitHub API: routes by "METHOD /path" (query ignored) and records each call. */
function fakeGitHub(routes: Record<string, (url: URL, body: unknown) => Response>) {
  const calls: { method: string; path: string; search: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, search: url.search, body, auth: new Headers(init?.headers).get("authorization") });
    const route = routes[`${method} ${url.pathname}`];
    const res = route ? route(url, body) : json(404, { message: `no route ${method} ${url.pathname}` });
    // Real responses carry their URL; Octokit's paginator reads it.
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const accessToken = () => json(201, { token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" });

describe("webhook signatures", () => {
  const body = JSON.stringify({ action: "created" });
  it("accepts GitHub's HMAC-SHA256 signature of the exact body and nothing else", () => {
    const sig = signWebhook("s3cret", body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("s3cret", body, sig)).toBe(true);
    expect(verifyWebhookSignature("s3cret", Buffer.from(body), sig)).toBe(true);
    expect(verifyWebhookSignature("s3cret", `${body} `, sig)).toBe(false);
    expect(verifyWebhookSignature("other", body, sig)).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, sig.replace("sha256=", "sha1="))).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, "sha256=abc")).toBe(false);
    expect(verifyWebhookSignature("s3cret", body, undefined)).toBe(false);
  });
});

describe("app registration and auth", () => {
  it("asks for the minimum permissions and events", () => {
    const m = appManifest({ name: "SHAPI", url: "https://shapi.dev", webhookUrl: "https://hooks.example/x", redirectUrl: "http://localhost:3999/callback", public: false });
    expect(m.default_permissions).toEqual({ metadata: "read", contents: "write", pull_requests: "write", checks: "write", issues: "write" });
    expect(m.default_events).toEqual(["push", "pull_request"]);
    expect(m.hook_attributes).toEqual({ url: "https://hooks.example/x", active: true });
    expect(Object.keys(APP_PERMISSIONS)).not.toContain("administration");
    expect(APP_EVENTS).not.toContain("issue_comment");
  });

  it("restores PEM newlines from env vars", () => {
    expect(normalizePrivateKey("-----BEGIN\\nabc\\n-----END")).toBe("-----BEGIN\nabc\n-----END");
    expect(normalizePrivateKey(privateKey)).toBe(privateKey);
  });

  it("creates a scoped installation token with a signed app JWT", async () => {
    const gh = fakeGitHub({ "POST /app/installations/42/access_tokens": accessToken });
    const token = await scopedInstallationToken(creds, 42, { repositoryIds: [7], permissions: { ...SCAN_PERMISSIONS } }, { fetch: gh.fetch });
    expect(token.token).toBe("ghs_installation");
    const call = gh.calls[0]!;
    expect(call.body).toEqual({ repository_ids: [7], permissions: { metadata: "read", contents: "read" } });
    const jwt = call.auth!.replace(/^bearer /i, "");
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("lists every repository of an installation across pages, as the installation", async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, full_name: `acme/r${i}`, default_branch: "main", private: true }));
    const gh = fakeGitHub({
      "POST /app/installations/42/access_tokens": accessToken,
      "GET /installation/repositories": (url) =>
        url.searchParams.get("page") === "2"
          ? json(200, { total_count: 101, repositories: page(1) })
          : json(200, { total_count: 101, repositories: page(100) }, { link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' }),
    });
    const repos = await listInstallationRepositories(installationOctokit(creds, 42, { fetch: gh.fetch }));
    expect(repos).toHaveLength(101);
    expect(gh.calls.filter((c) => c.path === "/installation/repositories").map((c) => c.auth)).toEqual(["token ghs_installation", "token ghs_installation"]);
  });

  it("exchanges the manifest code without credentials", async () => {
    const gh = fakeGitHub({ "POST /app-manifests/code123/conversions": () => json(201, { id: 9, slug: "shapi", pem: "k", webhook_secret: "w" }) });
    const app = await convertManifestCode("code123", { fetch: gh.fetch });
    expect(app).toMatchObject({ id: 9, slug: "shapi" });
    expect(gh.calls[0]!.auth).toBeNull();
  });
});

describe("check runs", () => {
  const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
  const site = (file: string, line: number) => ({ file, line }) as unknown as LockedCallSite;
  const finding = (file: string, line: number): Finding => ({ advisory, callSite: site(file, line), reasons: ["checks status === 204"] });

  it("passes when nothing is affected", () => {
    const r = checkRunOutput({ affected: [], exposed: [], upcoming: [] });
    expect(r.conclusion).toBe("success");
    expect(r.output.title).toBe("No call sites affected by known API changes");
    expect(r.output.annotations).toEqual([]);
  });

  it("reports affected call sites as neutral with warnings, or failure when the repo opts in", () => {
    const match = { affected: [finding("src/deploy.ts", 12)], exposed: [finding("src/other.ts", 3)], upcoming: [{ advisory, daysUntil: 5, callSites: 2 }] };
    const r = checkRunOutput(match);
    expect(r.conclusion).toBe("neutral");
    expect(r.output.title).toBe("1 call site affected by 1 API change");
    expect(r.output.summary).toContain("`src/deploy.ts:12`");
    expect(r.output.summary).toContain("in 5 days (2 call sites)");
    expect(r.output.annotations.map((a) => [a.path, a.start_line, a.annotation_level])).toEqual([
      ["src/deploy.ts", 12, "warning"],
      ["src/other.ts", 3, "notice"],
    ]);
    expect(r.output.annotations[0]!.message).toContain(advisory.migrationNote);
    expect(checkRunOutput(match, { failOnAffected: true }).conclusion).toBe("failure");
  });

  it("starts a check run and completes it, sending annotations 50 at a time", async () => {
    const gh = fakeGitHub({
      "POST /repos/acme/demo/check-runs": () => json(201, { id: 77 }),
      "PATCH /repos/acme/demo/check-runs/77": () => json(200, { id: 77 }),
    });
    const octokit = new Octokit({ auth: "t", request: { fetch: gh.fetch } });
    const id = await startCheckRun(octokit, { owner: "acme", repo: "demo", sha: "abc" });
    expect(id).toBe(77);
    expect(gh.calls[0]!.body).toMatchObject({ name: "SHAPI", head_sha: "abc", status: "in_progress" });

    const affected = Array.from({ length: 120 }, (_, i) => finding("src/deploy.ts", i + 1));
    await completeCheckRun(octokit, { owner: "acme", repo: "demo", checkRunId: 77 }, checkRunOutput({ affected, exposed: [], upcoming: [] }));
    const patches = gh.calls.filter((c) => c.method === "PATCH").map((c) => c.body as { status?: string; output: { annotations: unknown[] } });
    expect(patches.map((p) => p.output.annotations.length)).toEqual([50, 50, 20]);
    expect(patches[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(patches[1]!.status).toBeUndefined();
  });
});

describe("redelivery", () => {
  const d = (id: number, guid: string, status: number, at: string): HookDelivery => ({ id, guid, status_code: status, delivered_at: at, redelivery: false, event: "push" });

  it("retries the latest attempt of deliveries that never succeeded and SHAPI never received", () => {
    const plan = planRedeliveries(
      [
        d(1, "ok", 202, "2026-10-22T10:00:00Z"),
        d(2, "timeout", 0, "2026-10-22T10:01:00Z"),
        d(3, "flaky", 502, "2026-10-22T10:02:00Z"),
        d(4, "flaky", 502, "2026-10-22T10:05:00Z"),
        d(5, "flaky-then-ok", 500, "2026-10-22T10:03:00Z"),
        d(6, "flaky-then-ok", 202, "2026-10-22T10:04:00Z"),
        d(7, "stored", 500, "2026-10-22T10:06:00Z"),
        d(8, "dead", 500, "2026-10-22T09:00:00Z"),
        d(9, "dead", 500, "2026-10-22T09:10:00Z"),
        d(10, "dead", 500, "2026-10-22T09:20:00Z"),
      ],
      { received: new Set(["stored"]) },
    );
    expect(plan.redeliver.map((x) => x.id)).toEqual([2, 4]);
    expect(plan.givenUp).toEqual(["dead"]);
    expect(planRedeliveries([d(2, "timeout", 0, "2026-10-22T10:01:00Z"), d(3, "b", 0, "2026-10-22T10:02:00Z")], { received: new Set(), limit: 1 }).redeliver.map((x) => x.id)).toEqual([2]);
  });

  it("pages through GitHub's delivery log until it is older than the window", async () => {
    const gh = fakeGitHub({
      "POST /app/hook/deliveries": () => json(404, {}),
      "GET /app/hook/deliveries": (url) =>
        url.searchParams.get("cursor") === "next"
          ? json(200, [d(2, "b", 500, "2026-10-22T08:00:00Z"), d(1, "a", 500, "2026-10-20T08:00:00Z")])
          : json(200, [d(3, "c", 202, "2026-10-22T09:00:00Z")], { link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next>; rel="next"' }),
    });
    const list = await listRecentDeliveries(appOctokit(creds, { fetch: gh.fetch }), new Date("2026-10-21T00:00:00Z"));
    expect(list.map((x) => x.guid)).toEqual(["c", "b"]);
    expect(gh.calls.every((c) => /^bearer /i.test(c.auth ?? ""))).toBe(true);
  });
});
