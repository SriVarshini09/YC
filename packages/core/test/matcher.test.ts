import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, pathMatches, type CallSite, type Surface } from "@shapi/core";

const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-21T12:00:00Z");

const empty: Surface = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
let line = 0;
const site = (over: Omit<Partial<CallSite>, "surface"> & { surface?: Partial<Surface> }): CallSite => ({
  file: "src/app.ts",
  line: ++line,
  column: 3,
  provider: "github",
  kind: "http",
  client: "fetch",
  method: "POST",
  host: "api.github.com",
  endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches",
  resolved: true,
  ...over,
  surface: { ...empty, ...over.surface },
});

describe("pathMatches", () => {
  it("matches params, single-segment wildcards and multi-segment wildcards", () => {
    expect(pathMatches("/repos/{owner}/{repo}/actions/workflows/{}/dispatches", { path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" })).toBe(true);
    expect(pathMatches("/repos/acme/web/actions/workflows/ci.yml/dispatches", { path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" })).toBe(true);
    expect(pathMatches("/repos/{owner}/{repo}/actions/workflows/{id}/runs", { path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" })).toBe(false);
    expect(pathMatches("/v3/company/{realmId}/query", { path: "/v3/company/{realmId}/**" })).toBe(true);
    expect(pathMatches("/r/{sub}/top.json", { path: "/**/*.json" })).toBe(true);
    expect(pathMatches("/r/{sub}/about", { path: "/**/*.json" })).toBe(false);
    expect(pathMatches("/v21.0/me/accounts", { path: "/v21.0/**" })).toBe(true);
    expect(pathMatches("/v22.0/me", { path: "/v21.0/**" })).toBe(false);
    // an unknown segment in the call site does not match a literal in the pattern
    expect(pathMatches("/repos/{}/{}/{}", { path: "/repos/{owner}/{repo}/pulls" })).toBe(false);
  });
});

describe("matchAdvisories", () => {
  const lock = createApiLock(
    {
      callSites: [
        site({ surface: { statusCodes: [204] } }),
        site({ surface: { checksOk: true } }),
        site({
          kind: "sdk",
          client: "@octokit/rest",
          operation: "rest.actions.createWorkflowDispatch",
          endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
          surface: { statusCodes: [200, 204] },
        }),
        site({ method: "GET", endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches", surface: { statusCodes: [204] } }),
        site({ provider: "quickbooks", host: "quickbooks.api.intuit.com", method: "GET", endpoint: "/v3/company/{realmId}/query", surface: { query: [{ name: "minorversion", value: "65" }] } }),
        site({ provider: "quickbooks", host: "quickbooks.api.intuit.com", method: "GET", endpoint: "/v3/company/{realmId}/invoice", surface: { query: [{ name: "minorversion", value: "75" }] } }),
        site({ provider: "reddit", host: "oauth.reddit.com", method: "GET", endpoint: "/r/{sub}/top.json" }),
        site({ provider: "reddit", host: "www.reddit.com", method: "GET", endpoint: "/r/{sub}/top.json" }),
      ],
      declared: [{ provider: "hubspot", package: "@hubspot/api-client" }],
    },
    "test",
  );
  const result = matchAdvisories(lock, advisories, { now });
  const lines = (findings: typeof result.affected) => findings.map((f) => `${f.advisory.id}@${f.callSite.line}`);

  it("flags call sites that depend on the changed behavior, critical first", () => {
    const [first] = result.affected;
    expect(first?.advisory.id).toBe("github-workflow-dispatch-204-to-200");
    expect(first?.reasons).toEqual(["compares the response status to 204"]);
    expect(lines(result.affected)).toEqual([
      `github-workflow-dispatch-204-to-200@${lock.callSites[0]!.line}`,
      `quickbooks-minorversion-below-75-ignored@${lock.callSites[4]!.line}`,
      `reddit-logged-out-json-403@${lock.callSites[7]!.line}`,
    ]);
    expect(result.affected.find((f) => f.advisory.provider === "quickbooks")?.reasons).toEqual(["sends minorversion=65 (below 75)"]);
  });

  it("reports endpoint callers that do not depend on the change as exposed, and ignores other methods and hosts", () => {
    expect(lines(result.exposed)).toEqual([
      `github-workflow-dispatch-204-to-200@${lock.callSites[1]!.line}`,
      // already accepts both 200 and 204 (the advisory's newStatusCodes): handled, so only exposed
      `github-workflow-dispatch-204-to-200@${lock.callSites[2]!.line}`,
      `quickbooks-minorversion-below-75-ignored@${lock.callSites[5]!.line}`,
    ]);
  });

  it("lists deadlines within 90 days for providers present in the repo", () => {
    expect(result.upcoming.map((u) => [u.advisory.id, u.daysUntil, u.callSites])).toEqual([["hubspot-pipelines-v1-sunset", 44, 0]]);
    expect(matchAdvisories(lock, advisories, { now, horizonDays: 30 }).upcoming).toEqual([]);
  });
});
