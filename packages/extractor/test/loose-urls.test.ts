import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type CallSite } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";

// The shapes of code SHAPI used to miss on real repositories: URLs that no recognized client sends,
// bases kept in another file, local variables, URL objects and hosts built at runtime.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-28T12:00:00Z");

const FILES: Record<string, string> = {
  // a project's own HTTP helper, with the base from another module
  "src/hubspot/pipelines.ts": `import { apiRequest } from "./transport";
const endpoint = "/crm-pipelines/v1/pipelines/deals";
export const listPipelines = (ctx: unknown) => apiRequest.call(ctx, "GET", endpoint, {});
`,
  // a URL object, sent as a string
  "src/meta/api.ts": `const BASE_URL = "https://graph.facebook.com/v24.0";
export async function callApi(path: string) {
  const url = new URL(\`\${BASE_URL}/\${path}\`);
  const res = await fetch(url.toString());
  return res.json();
}
`,
  // a helper on a context object, and an error message that mentions the URL
  "src/meta/pixel.ts": `export async function send(ctx: any, pixelId: string, token: string) {
  const baseUrl = \`https://graph.facebook.com/v24.0/\${pixelId}/events?access_token=\`;
  const res = await ctx.fetch(\`\${baseUrl}\${token}\`, { method: "POST" });
  if (!res.ok) throw new Error(\`Facebook API error: \${baseUrl}****\`);
}
`,
  // a config object with a templated shop domain
  "src/shopify/app.ts": `export const app = {
  baseUrl: "https://{{config.shopDomain}}/admin/api/2026-01",
  webhooks: { url: "https://{{config.shopDomain}}/admin/api/2026-01/webhooks.json" },
};
`,
  // a fetch to a runtime shop domain
  "src/shopify/script.ts": `export const run = (shop: string) => fetch(\`https://\${shop}/admin/api/2026-01/graphql.json\`, { method: "POST" });
`,
  // the same const name in two functions: each URL uses its own function's base
  "src/probes.ts": `export function slack() {
  const api = "https://slack.com/api";
  return { url: \`\${api}/auth.test\` };
}
export function hubspot() {
  const api = "https://api.hubapi.com";
  return { url: \`\${api}/crm/v3/objects/contacts\` };
}
`,
  // a module constant on the provider's real host, used by a recognized client
  "src/github.ts": `const GITHUB_API = "https://api.github.com";
export const repo = (o: string, r: string) => fetch(\`\${GITHUB_API}/repos/\${o}/\${r}\`);
`,
  // Python: a local URL built from module constants, sent by an httpx client
  "py/meta.py": `import httpx

META_GRAPH_API_VERSION = "v24.0"
META_GRAPH_API_BASE = f"https://graph.facebook.com/{META_GRAPH_API_VERSION}"

async def make_request(endpoint, params):
    url = f"{META_GRAPH_API_BASE}/{endpoint}"
    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)
        return response.json()
`,
  // Python: a base imported from another module, sent by the project's own session
  "py/estuary_like.py": `from .shared import HUB

async def fetch_deal_pipelines(log, http):
    url = f"{HUB}/crm-pipelines/v1/pipelines/deals"
    return await http.request(log, url)
`,
  // Python: a Singer-style stream: the framework joins url_base and path
  "py/streams.py": `class DealPipelineStream:
    """Deal pipelines, see https://api.hubapi.com/crm-pipelines/v1 in the docs."""

    path = "crm-pipelines/v1/pipelines/deals"

    @property
    def url_base(self) -> str:
        return "https://api.hubapi.com/crm-pipelines/v1"
`,
};

let dir = "";
let sites: CallSite[] = [];
beforeAll(async () => {
  await loadPythonParser();
  dir = mkdtempSync(path.join(os.tmpdir(), "shapi-loose-"));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  sites = extractCallSites(dir).callSites;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const describeSite = (s: CallSite) => `${s.file}:${s.line} ${s.client} ${s.method ?? "?"} ${s.provider} ${s.endpoint}`;

describe("URLs outside recognized clients", () => {
  it("finds each call site once, with its provider and path", () => {
    expect(sites.map(describeSite)).toEqual([
      "py/estuary_like.py:4 url ? hubspot /crm-pipelines/v1/pipelines/deals",
      "py/meta.py:9 httpx GET meta-graph /v24.0/{endpoint}",
      "py/streams.py:4 url ? hubspot /crm-pipelines/v1/pipelines/deals",
      "src/github.ts:2 fetch GET github /repos/{o}/{r}",
      "src/hubspot/pipelines.ts:2 url ? hubspot /crm-pipelines/v1/pipelines/deals",
      "src/meta/api.ts:4 fetch GET meta-graph /v24.0/{path}",
      "src/meta/pixel.ts:2 url ? meta-graph /v24.0/{pixelId}/events",
      "src/probes.ts:3 url ? slack /api/auth.test",
      "src/probes.ts:7 url ? hubspot /crm/v3/objects/contacts",
      "src/shopify/app.ts:3 url ? shopify /admin/api/2026-01/webhooks.json",
      "src/shopify/script.ts:1 fetch POST shopify /admin/api/2026-01/graphql.json",
    ]);
  });

  it("does not count base constants, docstrings or error messages on their own", () => {
    expect(sites.some((s) => s.endpoint === "/v24.0" || s.endpoint === "/admin/api/2026-01" || s.endpoint === "/crm-pipelines/v1")).toBe(false);
    expect(sites.filter((s) => s.file === "src/meta/pixel.ts")).toHaveLength(1);
  });

  it("matches the advisories: affected where the path is known, possibly affected where it is built at runtime", () => {
    const match = matchAdvisories(createApiLock(extractCallSites(dir), "test"), advisories, { now });
    const key = (f: { advisory: { id: string }; callSite: CallSite }) => `${f.advisory.id} ${f.callSite.file}:${f.callSite.line}`;
    expect(match.affected.map(key).sort()).toEqual([
      "hubspot-pipelines-v1-sunset py/estuary_like.py:4",
      "hubspot-pipelines-v1-sunset py/streams.py:4",
      "hubspot-pipelines-v1-sunset src/hubspot/pipelines.ts:2",
      "shopify-admin-api-2026-01-unsupported src/shopify/app.ts:3",
      "shopify-admin-api-2026-01-unsupported src/shopify/script.ts:1",
      // the GraphQL call also needs expiring tokens from 2027 (POST /admin/api/{version}/graphql.json)
      "shopify-non-expiring-offline-tokens-rejected src/shopify/script.ts:1",
    ]);
    expect(match.possible.map(key).sort()).toEqual([
      "meta-graph-marketing-api-v24-sunset py/meta.py:9",
      "meta-graph-marketing-api-v24-sunset src/meta/api.ts:4",
      "meta-graph-marketing-api-v24-sunset src/meta/pixel.ts:2",
    ]);
  });
});
