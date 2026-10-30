import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, pathMatches, type Advisory, type CallSite, type Surface } from "@shapi/core";

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

  it("reads a repository full-name parameter right after /repos/ as owner/name (APIBreak-Replay)", () => {
    const dispatch = { path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" };
    expect(pathMatches("/repos/{repo}/actions/workflows/{workflow_id}/dispatches", dispatch)).toBe(true);
    expect(pathMatches("/repos/{full_name}/actions/workflows/{id}/dispatches", dispatch)).toBe(true);
    expect(pathMatches("/repos/{github.repository}/actions/workflows/{id}/dispatches", dispatch)).toBe(true);
    expect(pathMatches("/repos/{repo_slug}/actions/workflows/{id}/dispatches", dispatch)).toBe(true);
    // other names stay one segment, and only the segment right after /repos/ widens
    expect(pathMatches("/repos/{id}/actions/workflows/{workflow_id}/dispatches", dispatch)).toBe(false);
    expect(pathMatches("/orgs/{repo}/actions/workflows/{workflow_id}/dispatches", { path: "/orgs/{org}/{team}/actions/workflows/{id}/dispatches" })).toBe(false);
    expect(pathMatches("/repos/{owner}/{repo}/pulls", { path: "/repos/{owner}/{repo}/pulls" })).toBe(true);
    expect(pathMatches("/repos/{repo}/pulls", dispatch)).toBe(false);
  });

  it("matches {?} only against a value the code builds at runtime", () => {
    expect(pathMatches("/v1beta/models/{model}:generateContent", { path: "/*/models/{?}:*" })).toBe(true);
    expect(pathMatches("/v1beta/models/{}:generateContent", { path: "/*/models/{?}:*" })).toBe(true);
    expect(pathMatches("/v1beta/models/gemini-2.5-pro:generateContent", { path: "/*/models/{?}:*" })).toBe(false);
    expect(pathMatches("/v1beta/models/{model}:generateContent", { path: "/*/models/*:*" })).toBe(true);
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

describe("query value triggers", () => {
  const insights: Advisory = {
    id: "meta-graph-insights-metrics-removed",
    provider: "meta-graph",
    title: "Insights metrics removed",
    summary: "Some metric values return an error.",
    endpoint: { method: "GET", path: "/*/*/insights" },
    changeClass: "field-rename",
    trigger: { query: [{ name: "metric", values: ["page_impressions", "page_fans"] }] },
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2025-11-15",
    severity: "critical",
    migrationNote: "Use the replacement metrics.",
    sources: ["https://developers.facebook.com/docs/graph-api/reference/insights"],
    status: "verified",
  };
  const meta = (value: string | null) =>
    site({ provider: "meta-graph", host: "graph.facebook.com", method: "GET", endpoint: "/v24.0/{page}/insights", surface: { query: [{ name: "metric", value }] } });
  const lock = createApiLock({ callSites: [meta("page_views_total,page_fans"), meta("page_views_total"), meta(null)], declared: [] }, "test");
  const result = matchAdvisories(lock, [insights], { now });

  it("is affected only when the parameter is set to a listed value, including inside a comma-separated list", () => {
    expect(result.affected.map((f) => [f.callSite.line, f.reasons])).toEqual([[lock.callSites[0]!.line, ["sends metric=page_fans"]]]);
  });

  it("reports other or unknown values as exposed", () => {
    expect(result.exposed.map((f) => f.callSite.line)).toEqual([lock.callSites[1]!.line, lock.callSites[2]!.line]);
  });
});

describe("possibly affected", () => {
  const meta = (endpoint: string) => site({ provider: "meta-graph", host: "graph.facebook.com", method: "GET", endpoint });
  const byId = (id: string) => advisories.filter((a) => a.id === id);

  it("flags a runtime path on the changed version as possibly affected, not affected", () => {
    const result = matchAdvisories(createApiLock({ callSites: [meta("/v24.0/{endpoint}"), meta("/v24.0/{pixelId}/events")], declared: [] }, "test"), byId("meta-graph-marketing-api-v24-sunset"), { now });
    expect(result.affected).toEqual([]);
    expect(result.possible.map((f) => f.callSite.endpoint)).toEqual(["/v24.0/{endpoint}", "/v24.0/{pixelId}/events"]);
    expect(result.possible[0]!.reasons[0]).toContain("builds the path at runtime");
  });

  it("needs evidence: a known literal of the pattern (the version) in the known part of the path", () => {
    const result = matchAdvisories(createApiLock({ callSites: [meta("/v24.0/{path}"), meta("/{version}/{path}"), meta("/v23.0/{path}")], declared: [] }, "test"), byId("meta-graph-marketing-api-v24-sunset").concat(byId("meta-graph-commerce-order-management-removed")), { now });
    expect(result.possible.map((f) => `${f.advisory.id} ${f.callSite.endpoint}`)).toEqual(["meta-graph-marketing-api-v24-sunset /v24.0/{path}"]);
  });

  it("keeps a known ad-account path as affected", () => {
    const result = matchAdvisories(createApiLock({ callSites: [meta("/v24.0/act_{id}/campaigns")], declared: [] }, "test"), byId("meta-graph-marketing-api-v24-sunset"), { now });
    expect(result.affected).toHaveLength(1);
    expect(result.possible).toEqual([]);
  });
});

describe("method or host unknown", () => {
  const byId = (id: string) => advisories.filter((a) => a.id === id);
  const slack = (over: Partial<CallSite>) => site({ provider: "slack", host: "slack.com", client: "url", method: null, endpoint: "/api/files.upload", ...over });

  it("flags a matching path with an unknown method as possibly affected", () => {
    const lock = createApiLock({ callSites: [slack({}), slack({ endpoint: "/api/chat.postMessage" }), slack({ method: "GET" }), slack({ client: "fetch", method: "POST" })], declared: [] }, "test");
    const result = matchAdvisories(lock, byId("slack-files-upload-retired"), { now });
    expect(result.possible.map((f) => [f.callSite.line, f.reasons])).toEqual([
      [lock.callSites[0]!.line, ["calls ? /api/files.upload, but SHAPI cannot tell the method (affected if it is POST)"]],
    ]);
    expect(result.affected.map((f) => f.callSite.line)).toEqual([lock.callSites[3]!.line]);
    expect(result.exposed).toEqual([]);
  });

  it("flags a matching path with an unknown host as possibly affected when the advisory names hosts", () => {
    const sf = (host: string | null) => site({ provider: "salesforce", host, method: "POST", endpoint: "/services/Soap/u/58.0" });
    const lock = createApiLock({ callSites: [sf(null), sf("acme.my.salesforce.com"), sf("login.salesforce.com")], declared: [] }, "test");
    const result = matchAdvisories(lock, byId("salesforce-soap-login-use-any-api-auth-required"), { now });
    expect(result.possible.map((f) => [f.callSite.line, f.reasons])).toEqual([
      [lock.callSites[0]!.line, ["calls POST /services/Soap/u/58.0, but SHAPI cannot tell the host (affected if it is login.salesforce.com or test.salesforce.com)"]],
    ]);
    expect(result.affected.map((f) => f.callSite.line)).toEqual([lock.callSites[2]!.line]);
  });
});

describe("enum value triggers", () => {
  const neo = advisories.filter((a) => a.id === "quickbooks-companyinfo-neoenabled-removed");
  const qbo = (values: string[]) =>
    site({ provider: "quickbooks", host: "quickbooks.api.intuit.com", method: "GET", endpoint: "/v3/company/{realm}/companyinfo/{realm}", surface: { enums: [{ field: "CompanyInfo.NameValue[].Name", values }] } });

  it("is affected only when the field is compared to a listed value", () => {
    const lock = createApiLock({ callSites: [qbo(["IndustryType", "NeoEnabled"]), qbo(["IndustryType"])], declared: [] }, "test");
    const result = matchAdvisories(lock, neo, { now });
    expect(result.affected.map((f) => [f.callSite.line, f.reasons])).toEqual([[lock.callSites[0]!.line, ['compares CompanyInfo.NameValue[].Name to "NeoEnabled"']]]);
    expect(result.exposed.map((f) => f.callSite.line)).toEqual([lock.callSites[1]!.line]);
  });
});

describe("days until a deadline", () => {
  const lock = createApiLock({ callSites: [], declared: [{ provider: "hubspot", package: "@hubspot/api-client" }] }, "test");
  const days = (at: string) => matchAdvisories(lock, advisories, { now: new Date(at) }).upcoming.find((u) => u.advisory.id === "hubspot-pipelines-v1-sunset")?.daysUntil;

  it("counts UTC calendar days, whatever the local time zone (the deadline is 2026-12-04)", () => {
    expect(days("2026-12-03T23:30:00Z")).toBe(1);
    // 23:30 on Dec 3 in California is already Dec 4 in UTC
    expect(days("2026-12-03T23:30:00-08:00")).toBe(0);
    expect(days("2026-12-04T00:30:00+09:00")).toBe(1);
  });
});
