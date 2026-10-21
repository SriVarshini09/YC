import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiLockSchema, apiLockJsonSchema, callSiteId, createApiLock, serializeApiLock, type CallSite } from "@shapi/core";

const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema", "api-lock.schema.json");

const surface = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
const site = (over: Partial<CallSite>): CallSite => ({
  file: "src/a.ts",
  line: 1,
  column: 1,
  provider: "github",
  kind: "http",
  client: "fetch",
  method: "GET",
  host: "api.github.com",
  endpoint: "/repos/{owner}/{repo}",
  resolved: true,
  surface,
  ...over,
});

describe("api.lock", () => {
  const sites = [
    site({ file: "src/b.ts", line: 3, surface: { ...surface, statusCodes: [204] } }),
    site({ file: "src/a.ts", line: 9, provider: "stripe", host: "api.stripe.com", endpoint: "/v1/customers", method: "POST" }),
    site({ file: "src/a.ts", line: 2, provider: null, host: null, endpoint: null, resolved: false }),
  ];
  const declared = [
    { provider: "stripe", package: "stripe" },
    { provider: "github", package: "@octokit/rest" },
    { provider: "slack", package: "@slack/web-api" },
  ];

  it("sorts call sites, assigns stable ids, and summarizes providers", () => {
    const lock = createApiLock({ callSites: sites, declared }, "shapi test");
    expect(lock.callSites.map((s) => `${s.file}:${s.line}`)).toEqual(["src/a.ts:2", "src/a.ts:9", "src/b.ts:3"]);
    expect(lock.callSites[0]!.id).toBe(callSiteId(sites[2]!));
    expect(lock.callSites[0]!.id).toMatch(/^[0-9a-f]{12}$/);
    expect(lock.providers).toEqual([
      { id: "github", callSites: 1, declaredBy: ["@octokit/rest"] },
      { id: "slack", callSites: 0, declaredBy: ["@slack/web-api"] },
      { id: "stripe", callSites: 1, declaredBy: ["stripe"] },
    ]);
  });

  it("serializes byte-identically regardless of input order", () => {
    const a = serializeApiLock(createApiLock({ callSites: sites, declared }, "shapi test"));
    const b = serializeApiLock(createApiLock({ callSites: [...sites].reverse(), declared: [...declared].reverse() }, "shapi test"));
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    // keys come out in schema order, id first
    expect(Object.keys(JSON.parse(a).callSites[0]).slice(0, 3)).toEqual(["id", "file", "line"]);
    expect(ApiLockSchema.parse(JSON.parse(a))).toEqual(JSON.parse(a));
  });

  it("rejects malformed locks", () => {
    expect(() => ApiLockSchema.parse({ lockfileVersion: 2, generator: "x", providers: [], callSites: [] })).toThrow();
  });

  it("keeps schema/api-lock.schema.json in sync (UPDATE_SCHEMA=1 rewrites it)", () => {
    const generated = JSON.stringify(apiLockJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA || !existsSync(schemaFile)) writeFileSync(schemaFile, generated);
    expect(readFileSync(schemaFile, "utf8")).toBe(generated);
  });
});
