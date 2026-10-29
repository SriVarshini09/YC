import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCallSites, parseUrl } from "@shapi/extractor";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "calls");

describe("extractCallSites", () => {
  const result = extractCallSites(fixture);
  const sites = result.callSites;
  const at = (file: string, line: number) => sites.find((s) => s.file === file && s.line === line);

  it("scans every source file and reports call sites sorted by file and line", () => {
    expect(result.filesScanned).toBe(3);
    expect(sites).toHaveLength(16);
    const keys = sites.map((s) => `${s.file}:${String(s.line).padStart(4, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("resolves fetch with a template URL and an env fallback base", () => {
    expect(at("src/http.ts", 8)).toMatchObject({
      provider: "github",
      kind: "http",
      client: "fetch",
      method: "POST",
      host: "api.github.com",
      endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches",
      resolved: true,
      column: 10,
    });
    // property access and wrapped substitutions become named params; query strings are dropped
    expect(at("src/http.ts", 15)).toMatchObject({ method: "GET", endpoint: "/repos/{owner}/{repo}" });
  });

  it("handles axios verbs, axios config objects, axios instances, got, and undici", () => {
    expect(at("src/http.ts", 19)).toMatchObject({ provider: "stripe", client: "axios", method: "POST", endpoint: "/v1/charges" });
    expect(at("src/http.ts", 23)).toMatchObject({ provider: "slack", method: "POST", endpoint: "/api/chat.postMessage" });
    expect(at("src/http.ts", 28)).toMatchObject({ provider: "hubspot", host: "api.hubapi.com", endpoint: "/crm/v3/objects/contacts" });
    expect(at("src/http.ts", 32)).toMatchObject({ provider: "twilio", client: "got", endpoint: "/2010-04-01/Accounts/{sid}/Messages.json" });
    expect(at("src/http.ts", 36)).toMatchObject({ provider: "openai", client: "undici", method: "GET" });
  });

  it("marks calls it cannot resolve instead of dropping them", () => {
    expect(at("src/http.ts", 40)).toMatchObject({ provider: null, endpoint: null, resolved: false });
    expect(at("src/http.ts", 44)).toMatchObject({ provider: null, host: null, endpoint: "/api/health", resolved: false });
    expect(at("src/sdk.ts", 11)).toMatchObject({ provider: "stripe", operation: "somethingNew.doIt", endpoint: null, resolved: false });
  });

  it("maps SDK method chains and octokit.request routes to endpoints", () => {
    expect(at("src/sdk.ts", 8)).toMatchObject({
      provider: "github",
      kind: "sdk",
      client: "@octokit/rest",
      operation: "rest.actions.createWorkflowDispatch",
      method: "POST",
      endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
    });
    expect(at("src/sdk.ts", 9)).toMatchObject({ method: "GET", endpoint: "/repos/{owner}/{repo}/pulls" });
    expect(at("src/sdk.ts", 10)).toMatchObject({ provider: "stripe", method: "POST", endpoint: "/v1/customers" });
    expect(at("src/sdk.ts", 17)).toMatchObject({ provider: "stripe", operation: "paymentIntents.create" });
  });

  it("understands CommonJS require", () => {
    expect(at("src/legacy.js", 6)).toMatchObject({ provider: "xero", client: "node-fetch", method: "PUT" });
    expect(at("src/legacy.js", 7)).toMatchObject({ provider: "github", client: "@octokit/core", method: "POST", endpoint: "/repos/{owner}/{repo}/dispatches" });
  });

  it("reports providers declared in package.json", () => {
    expect(result.declared.map((d) => `${d.provider}:${d.package}`)).toEqual(["github:@octokit/rest", "stripe:stripe"]);
  });
});

describe("parseUrl", () => {
  it("splits host and path and normalizes slashes", () => {
    expect(parseUrl("https://API.github.com//repos/x/?a=1&b#h")).toEqual({
      host: "api.github.com",
      path: "/repos/x",
      query: [
        { name: "a", value: "1" },
        { name: "b", value: null },
      ],
    });
    expect(parseUrl("{base}/v1/things")).toEqual({ host: null, path: "/v1/things", query: [] });
    expect(parseUrl("https://{host}/v1")).toEqual({ host: null, path: "/v1", query: [], runtimeHost: "{host}" });
    expect(parseUrl(undefined)).toEqual({ host: null, path: null, query: [] });
  });
});
