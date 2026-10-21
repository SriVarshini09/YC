import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractCallSites } from "@shapi/extractor";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "surface");

describe("dependency surface", () => {
  const { callSites } = extractCallSites(fixture);
  const site = (file: string, endpoint: string) => {
    const s = callSites.find((c) => c.file === file && c.endpoint === endpoint);
    if (!s) throw new Error(`no call site ${file} ${endpoint}: ${callSites.map((c) => c.endpoint).join(", ")}`);
    return s.surface;
  };

  it("captures the status code a fetch call branches on, and its request headers", () => {
    const s = site("src/github.ts", "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches");
    expect(s.statusCodes).toEqual([204]);
    expect(s.checksOk).toBe(false);
    expect(s.headers).toEqual([
      { name: "authorization", value: "Bearer {token}" },
      { name: "accept", value: "application/vnd.github+json" },
      { name: "x-github-api-version", value: "2022-11-28" },
    ]);
  });

  it("follows res.json() into body fields, enum comparisons, switch cases, ok and response headers", () => {
    const s = site("src/github.ts", "/repos/{owner}/{repo}/actions/runs");
    expect(s.checksOk).toBe(true);
    expect(s.responseHeaders).toEqual(["x-ratelimit-remaining"]);
    expect(s.fields).toEqual(["workflow_runs[]", "workflow_runs[].conclusion"]);
    expect(s.enums).toEqual([{ field: "workflow_runs[].conclusion", values: ["cancelled", "failure", "success"] }]);
    expect(s.query).toEqual([
      { name: "per_page", value: "1" },
      { name: "status", value: "completed" },
    ]);
  });

  it("handles destructured SDK responses and includes() status checks", () => {
    const s = site("src/github.ts", "/repos/{owner}/{repo}/pulls/{pull_number}");
    expect(s.statusCodes).toEqual([200, 304]);
    expect(s.fields).toEqual(["merge_commit_sha", "merged", "state"]);
    expect(s.enums).toEqual([{ field: "state", values: ["open"] }]);
  });

  it("treats body-returning SDKs, axios data, got json and then-callbacks correctly", () => {
    const stripe = site("src/others.ts", "/v1/customers");
    expect(stripe.fields).toEqual(["address.country", "id", "tax_exempt"]);
    expect(stripe.enums).toEqual([{ field: "tax_exempt", values: ["reverse"] }]);
    expect(stripe.headers).toEqual([{ name: "stripe-version", value: "2023-10-16" }]);

    const hubspot = site("src/others.ts", "/crm/v3/objects/contacts");
    expect(hubspot.statusCodes).toEqual([200]);
    expect(hubspot.fields).toEqual(["results"]);
    expect(hubspot.query).toEqual([{ name: "limit", value: "10" }]);

    const twilio = site("src/others.ts", "/2010-04-01/Accounts/AC1/Messages.json");
    expect(twilio.fields).toEqual(["sid", "status"]);
    expect(twilio.enums).toEqual([{ field: "status", values: ["queued"] }]);

    expect(site("src/others.ts", "/v1/models").statusCodes).toEqual([401]);
    expect(site("src/others.ts", "/v3/company/{realmId}/query").query).toEqual([
      { name: "query", value: "select" },
      { name: "minorversion", value: "65" },
    ]);
  });
});
