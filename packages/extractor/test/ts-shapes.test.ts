import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type CallSite } from "@shapi/core";
import { extractCallSites, parseUrl } from "@shapi/extractor";

// TypeScript and JavaScript shapes the extractor used to miss or record wrongly (review 3, B1-B10).
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-28T12:00:00Z");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scan(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-ts-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return extractCallSites(dir);
}
const sitesOf = (files: Record<string, string>) => scan(files).callSites;
const affectedIds = (files: Record<string, string>) =>
  matchAdvisories(createApiLock(scan(files), "test"), advisories, { now }).affected.map((f) => f.advisory.id);
const line = (s: CallSite) => `${s.client} ${s.method ?? "?"} ${s.provider} ${s.host} ${s.endpoint}`;

describe("hosts built at runtime (B1)", () => {
  it("resolves the provider from a fixed wildcard suffix", () => {
    const sites = sitesOf({
      "a.ts": `export const f = (sub: string, dc: string, shop: string, site: string) => {
  fetch(\`https://\${sub}.zendesk.com/api/v2/tickets.json\`);
  fetch(\`https://\${dc}.api.mailchimp.com/3.0/lists\`);
  fetch(\`https://\${shop}.myshopify.com/admin/api/2026-01/products.json\`);
  fetch(\`https://\${site}.atlassian.net/rest/api/3/issue\`);
  fetch(\`https://\${site}/v1/unknown\`);
};
`,
    });
    expect(sites.map(line)).toEqual([
      "fetch GET zendesk null /api/v2/tickets.json",
      "fetch GET mailchimp null /3.0/lists",
      "fetch GET shopify null /admin/api/2026-01/products.json",
      "fetch GET atlassian null /rest/api/3/issue",
      "fetch GET null null /v1/unknown",
    ]);
  });

  it("resolves a Shopify Admin path whose version is a runtime value, and matches its advisory", () => {
    const files = {
      "a.ts": "export const f = (shop: string, ver: string) => fetch(`https://${shop}/admin/api/${ver}/script_tags.json`, { method: \"POST\" });\n",
    };
    expect(sitesOf(files).map(line)).toEqual(["fetch POST shopify null /admin/api/{ver}/script_tags.json"]);
    expect(affectedIds(files)).toContain("shopify-script-tags-stop-running");
  });
});

describe("HTTP clients on class members (B2)", () => {
  it("matches this.http.get on an axios instance", () => {
    const sites = sitesOf({
      "a.ts": `import axios from "axios";
class C {
  http = axios.create({ baseURL: "https://api.stripe.com" });
  f() { return this.http.get("/v1/customers"); }
}
`,
    });
    expect(sites.map(line)).toEqual(["axios GET stripe api.stripe.com /v1/customers"]);
  });
});

describe("instance headers and params (B3)", () => {
  it("keeps axios.create headers and params on every call", () => {
    const files = {
      "a.ts": `import axios from "axios";
const api = axios.create({ baseURL: "https://api.anthropic.com", headers: { "anthropic-version": "2026-10-21" }, params: { beta: "true" } });
export const f = () => api.post("/v1/messages", { model: "m" }, { headers: { "x-api-key": "k" } });
`,
    };
    const [site] = sitesOf(files);
    expect(site!.surface.headers).toEqual([
      { name: "anthropic-version", value: "2026-10-21" },
      { name: "x-api-key", value: "k" },
    ]);
    expect(site!.surface.query).toEqual([{ name: "beta", value: "true" }]);
    expect(affectedIds(files)).toContain("anthropic-api-version-2026-10-21-sampling-params-400");
  });

  it("keeps got.extend headers and searchParams, and lets a call override a header", () => {
    const [site] = sitesOf({
      "a.ts": `import got from "got";
const qbo = got.extend({ prefixUrl: "https://quickbooks.api.intuit.com", headers: { Accept: "application/json" }, searchParams: { minorversion: 65 } });
export const f = (realm: string) => qbo.get(\`v3/company/\${realm}/companyinfo/\${realm}\`, { headers: { accept: "text/plain" } });
`,
    });
    expect(site!.surface.headers).toEqual([{ name: "accept", value: "text/plain" }]);
    expect(site!.surface.query).toEqual([{ name: "minorversion", value: "65" }]);
  });
});

describe("promise chains (B4)", () => {
  it("follows fetch().then((r) => r.json()).then((d) => ...)", () => {
    const [site] = sitesOf({
      "a.ts": 'export const f = () => fetch("https://api.xero.com/api.xro/2.0/Organisation").then((r) => r.json()).then((d) => d.Organisations[0].Class === "PREMIUM");\n',
    });
    expect(site!.surface.fields).toEqual(["Organisations[].Class"]);
    expect(site!.surface.enums).toEqual([{ field: "Organisations[].Class", values: ["PREMIUM"] }]);
  });

  it("follows a block-bodied callback that returns the body, and an awaited chain", () => {
    const [a, b] = sitesOf({
      "a.ts": `export async function f() {
  fetch("https://api.github.com/repos/a/b").then(function (r) { if (!r.ok) throw new Error(); return r.json(); }).then((d) => d.full_name);
  const repo = await fetch("https://api.github.com/repos/a/c").then((r) => r.json());
  return repo.default_branch;
}
`,
    });
    expect(a!.surface).toMatchObject({ checksOk: true, fields: ["full_name"] });
    expect(b!.surface.fields).toEqual(["default_branch"]);
  });
});

describe("SDK clients exported from another file (B5)", () => {
  it("follows a relative import to the module that constructs the client", () => {
    const sites = sitesOf({
      "lib/openai.ts": 'import OpenAI from "openai";\nexport const openai = new OpenAI();\n',
      "lib/stripe.ts": 'import Stripe from "stripe";\nconst stripe = new Stripe("k", { apiVersion: "2024-06-20" });\nexport default stripe;\n',
      "lib/index.ts": 'export { openai as ai } from "./openai";\n',
      "app.ts": `import { openai } from "./lib/openai.js";
import stripe from "./lib/stripe";
import { ai } from "./lib";
export const f = () => openai.chat.completions.create({ model: "gpt-4" });
export const g = () => stripe.customers.create({});
export const h = () => ai.chat.completions.create({ model: "gpt-4o" });
`,
    });
    expect(sites.map((s) => `${s.file}:${s.line} ${s.provider} ${s.operation} ${s.method} ${s.endpoint}`)).toEqual([
      "app.ts:4 openai chat.completions.create POST /v1/chat/completions",
      "app.ts:5 stripe customers.create POST /v1/customers",
      "app.ts:6 openai chat.completions.create POST /v1/chat/completions",
    ]);
    expect(sites[1]!.surface.headers).toEqual([{ name: "stripe-version", value: "2024-06-20" }]);
  });

  it("does not treat an imported name that is not an SDK client as one", () => {
    const sites = sitesOf({
      "lib/util.ts": "export const helpers = { chat: { completions: { create: (x: unknown) => x } } };\n",
      "app.ts": 'import { helpers } from "./lib/util";\nexport const f = () => helpers.chat.completions.create({});\n',
    });
    expect(sites).toEqual([]);
  });
});

describe("other ways to import a client (B6)", () => {
  it("understands import X = require(), require().default and undici's module object", () => {
    const sites = sitesOf({
      "a.ts": 'import Stripe = require("stripe");\nconst s = new Stripe("k");\nexport const f = () => s.customers.create({});\n',
      "b.ts": 'const axios = require("axios").default;\nexport const f = () => axios.get("https://api.github.com/repos/a/b");\n',
      "c.js": 'const undici = require("undici");\nexports.f = () => undici.request("https://api.github.com/repos/a/c");\n',
    });
    expect(sites.map((s) => `${s.file} ${s.client} ${s.method} ${s.provider} ${s.endpoint}`)).toEqual([
      "a.ts stripe POST stripe /v1/customers",
      "b.ts axios GET github /repos/a/b",
      "c.js undici GET github /repos/a/c",
    ]);
  });
});

describe("new URL(path, base) (B7)", () => {
  it("resolves the path against the base the way URL does", () => {
    const sites = sitesOf({
      "a.ts": `const GRAPH = "https://graph.facebook.com/v20.0/";
export const f = () => fetch(new URL("/v21.0/me", GRAPH));
export const g = () => fetch(new URL("me/accounts", GRAPH));
export const h = () => fetch(new URL("customers", "https://api.stripe.com/v1"));
export const i = (id: string) => fetch(new URL(\`../v19.0/\${id}\`, "https://graph.facebook.com/v20.0/x"));
export const j = () => fetch(new URL("https://api.github.com/user", GRAPH));
`,
    });
    expect(sites.map((s) => `${s.host} ${s.endpoint}`)).toEqual([
      "graph.facebook.com /v21.0/me",
      "graph.facebook.com /v20.0/me/accounts",
      "api.stripe.com /customers",
      "graph.facebook.com /v19.0/{id}",
      "api.github.com /user",
    ]);
  });
});

describe("parseUrl (B8)", () => {
  it("drops userinfo and the port from the host, and decodes the query", () => {
    expect(parseUrl("https://user:pw@login.salesforce.com:443/services/Soap/u/58.0?metric=page_fans%2Cpage_impressions&q=a+b")).toEqual({
      host: "login.salesforce.com",
      path: "/services/Soap/u/58.0",
      query: [
        { name: "metric", value: "page_fans,page_impressions" },
        { name: "q", value: "a b" },
      ],
    });
    // a malformed escape stays as written
    expect(parseUrl("https://api.github.com/x?q=100%")).toMatchObject({ query: [{ name: "q", value: "100%" }] });
    const [site] = sitesOf({ "a.ts": 'export const f = () => fetch("https://user:pw@api.github.com/repos/a/b");\n' });
    expect(line(site!)).toBe("fetch GET github api.github.com /repos/a/b");
  });
});

describe("SDK hosts (B9)", () => {
  it("leaves the host unknown for SDKs whose provider serves per-tenant hosts", () => {
    const sites = sitesOf({
      "a.ts": `import Shopify from "shopify-api-node";
import Stripe from "stripe";
const shopify = new Shopify({ shopName: "s", accessToken: "t" });
const stripe = new Stripe("k");
export const f = () => shopify.product.list();
export const g = () => stripe.customers.create({});
`,
    });
    expect(sites.map((s) => `${s.provider} ${s.host}`)).toEqual(["shopify null", "stripe api.stripe.com"]);
  });
});

describe("large generated files (B10)", () => {
  it("scans a file with thousands of calls and URLs in linear time", () => {
    let js = "";
    for (let i = 0; i < 12000; i++) js += `fetch("https://api.github.com/repos/a/b${i}");var s${i}="https://api.stripe.com/v1/x${i}";\n`;
    const t0 = Date.now();
    const sites = sitesOf({ "src/big.js": js });
    const ms = Date.now() - t0;
    expect(sites).toHaveLength(24000);
    // under 1 s; the quadratic scan took over 20 s
    expect(ms).toBeLessThan(10_000);
  });

  it("skips minified bundles and public/ like node_modules", () => {
    const call = 'fetch("https://api.github.com/repos/a/b");\n';
    const result = scan({ "public/app.js": call, "src/vendor.min.js": call, "src/app.bundle.js": call, "src/app.ts": call });
    expect(result.filesScanned).toBe(1);
    expect(result.callSites.map((s) => s.file)).toEqual(["src/app.ts"]);
  });

  it("skips public/ only at the root and next to a package.json, where frameworks serve static files from", () => {
    const call = 'fetch("https://api.github.com/repos/a/b");\n';
    const result = scan({
      "apps/web/package.json": "{}",
      "apps/web/public/app.js": call,
      "src/public/api.ts": call,
      "lib/public/client.js": call,
    });
    expect(result.callSites.map((s) => s.file)).toEqual(["lib/public/client.js", "src/public/api.ts"]);
  });
});
