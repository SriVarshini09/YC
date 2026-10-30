import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@shapi/db";
import { buildApp } from "../src/index";
import { DOCS_CSP } from "../src/docs";

const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-docs-"));
const outside = path.join(path.dirname(dir), "secret.txt");
const config = { LOG_LEVEL: "info" as const, GIT_SHA: "t", NODE_ENV: "test" as const, docs: { url: "https://shapi.dev", dir } };
// The docs routes never touch the database.
const app = buildApp({ db: {} as Db, config });

beforeAll(() => {
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  put("index.html", "<h1>home</h1>");
  put("guide/cli.html", "<h1>cli</h1>");
  put("legal/index.html", "<h1>legal</h1>");
  put("assets/app.abc123.js", "console.log(1)");
  put("404.html", "<h1>not found</h1>");
  put("schema/advisory.json", '{"$id":"https://shapi.dev/schema/advisory.json"}');
  put("osv/stripe-x.json", '{"id":"x_SHAPI-stripe-x"}');
  put("overlays/stripe-x.overlay.json", '{"overlay":"1.0.0"}');
  put("arazzo/stripe-x.arazzo.json", '{"arazzo":"1.0.1"}');
  put("advisories/stripe-x.md", "# Stripe x");
  put("deadlines.ics", "BEGIN:VCALENDAR");
  put("api/v1/providers/stripe.json", '{"provider":"stripe"}');
  put(".hidden", "no");
  writeFileSync(outside, "outside the docs");
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { force: true });
});

const get = (url: string, host = "shapi.dev", method: "GET" | "HEAD" | "POST" = "GET") => app.inject({ method, url, headers: { host } });

describe("docs site on its own hostname", () => {
  it("serves pages with clean URLs and the docs headers", async () => {
    const home = await get("/");
    expect(home.statusCode).toBe(200);
    expect(home.body).toBe("<h1>home</h1>");
    expect(home.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(home.headers["content-security-policy"]).toBe(DOCS_CSP);
    expect(home.headers["cache-control"]).toBe("public, max-age=300");
    expect((await get("/guide/cli")).body).toBe("<h1>cli</h1>");
    expect((await get("/guide/cli.html")).body).toBe("<h1>cli</h1>");
    expect((await get("/guide/cli?ref=x#top")).body).toBe("<h1>cli</h1>");
    expect((await get("/legal/")).body).toBe("<h1>legal</h1>");
    expect((await get("/legal")).body).toBe("<h1>legal</h1>");
    expect((await get("/", "shapi.dev", "HEAD")).statusCode).toBe(200);
  });

  it("serves the published advisory JSON Schema and OSV records to any origin (S-01, S-03)", async () => {
    const schema = await get("/schema/advisory.json");
    expect(schema.statusCode).toBe(200);
    expect(schema.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(schema.headers["access-control-allow-origin"]).toBe("*");
    expect(schema.json()).toEqual({ $id: "https://shapi.dev/schema/advisory.json" });
    const osv = await get("/osv/stripe-x.json");
    expect(osv.headers["access-control-allow-origin"]).toBe("*");
    expect(osv.json()).toEqual({ id: "x_SHAPI-stripe-x" });
    for (const p of ["/overlays/stripe-x.overlay.json", "/arazzo/stripe-x.arazzo.json"]) expect((await get(p)).headers["access-control-allow-origin"]).toBe("*");
    // Other files are not shared across origins.
    expect((await get("/guide/cli")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves the advisory Markdown twins, the deadlines feed and the provider JSON with their types (G-04)", async () => {
    expect((await get("/advisories/stripe-x.md")).headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect((await get("/deadlines.ics")).headers["content-type"]).toBe("text/calendar; charset=utf-8");
    const json = await get("/api/v1/providers/stripe.json");
    expect(json.headers["access-control-allow-origin"]).toBe("*");
    expect(json.json()).toEqual({ provider: "stripe" });
  });

  it("caches hashed assets for a year", async () => {
    const js = await get("/assets/app.abc123.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.headers["content-security-policy"]).toBeUndefined();
  });

  it("answers unknown paths, hidden files and escapes with the 404 page", async () => {
    for (const url of ["/nope", "/.hidden", "/../secret.txt", "/%2e%2e/secret.txt", "/guide/%2e%2e/%2e%2e/secret.txt", "/%00", "/%5c.hidden", "/guide%5c..%5cindex.html"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("outside the docs");
    }
    // A URL that does not decode is refused before it reaches the docs.
    expect((await get("/%E0%A4%A")).statusCode).toBe(400);
    expect((await get("/nope")).body).toBe("<h1>not found</h1>");
  });

  it("redirects www to the docs host and refuses writes", async () => {
    const www = await get("/guide/cli?x=1", "www.shapi.dev");
    expect(www.statusCode).toBe(301);
    expect(www.headers.location).toBe("https://shapi.dev/guide/cli?x=1");
    expect((await get("/", "shapi.dev", "POST")).statusCode).toBe(405);
  });

  it("keeps the app's routes off the docs host, and the docs off the app's host", async () => {
    // On shapi.dev the app's paths are just missing docs pages.
    expect((await get("/healthz")).statusCode).toBe(404);
    expect((await get("/login")).statusCode).toBe(404);
    expect((await get("/github/webhook", "shapi.dev", "POST")).statusCode).toBe(405);
    // The app's own host is untouched.
    const health = await get("/healthz", "app.shapi.dev");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect((await get("/guide/cli", "app.shapi.dev")).body).not.toBe("<h1>cli</h1>");
  });
});
