import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type CallSite } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "python");
const root = path.resolve(here, "..", "..", "..");

let sites: CallSite[] = [];
beforeAll(async () => {
  await loadPythonParser();
  sites = extractCallSites(fixture).callSites;
});
const at = (file: string, line: number) => {
  const s = sites.find((c) => c.file === file && c.line === line);
  if (!s) throw new Error(`no call site at ${file}:${line}: ${sites.map((c) => `${c.file}:${c.line}`).join(", ")}`);
  return s;
};

describe("Python call sites", () => {
  it("finds requests, httpx and aiohttp calls, with URLs from f-strings, constants, base_url and os.getenv defaults", () => {
    expect(sites.filter((s) => s.kind === "http").map((s) => `${s.client} ${s.provider} ${s.method} ${s.endpoint}`)).toEqual([
      "requests github POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches",
      "requests quickbooks GET /v3/company/{realm_id}/query",
      "httpx hubspot GET /crm-pipelines/v1/pipelines/deals",
      "aiohttp meta-graph GET /v21.0/{page_id}",
    ]);
  });

  it("records what the code depends on: status checks, headers, query params and body fields", () => {
    expect(at("app/clients.py", 12).surface).toMatchObject({
      statusCodes: [204],
      headers: [{ name: "authorization", value: "Bearer {token}" }, { name: "x-github-api-version", value: "2022-11-28" }],
    });
    expect(at("app/clients.py", 22).surface).toMatchObject({
      checksOk: true,
      fields: ["QueryResponse.Invoice", "QueryResponse.Invoice[].Id"],
      query: [{ name: "query", value: "select * from Invoice" }, { name: "minorversion", value: "65" }],
    });
    // for-loops, generator expressions and .get("key") into list items
    expect(at("app/clients.py", 33).surface).toMatchObject({
      fields: ["results", "results[].label", "results[].pipelineId", "results[].stages", "results[].stages[].stageId"],
      enums: [{ field: "results[].label", values: ["Sales"] }],
      headers: [{ name: "authorization", value: "Bearer {token}" }],
    });
    // async with session.get(...) as resp, resp.status in (200, 201), await resp.json()
    expect(at("app/clients.py", 45).surface).toMatchObject({ statusCodes: [200, 201], fields: ["name"], query: [{ name: "fields", value: "name" }] });
  });

  it("maps SDK calls to their endpoints and reads attribute access on the results", () => {
    expect(sites.filter((s) => s.kind === "sdk").map((s) => `${s.client} ${s.operation} → ${s.method} ${s.endpoint}`)).toEqual([
      "stripe checkout.Session.retrieve → GET /v1/checkout/sessions/{session}",
      "openai chat.completions.create → POST /v1/chat/completions",
      "slack_sdk files_upload → POST /api/files.upload",
      "slack_sdk chat_postMessage → POST /api/chat.postMessage",
      "twilio messages.create → POST /2010-04-01/Accounts/{AccountSid}/Messages.json",
    ]);
    expect(at("app/sdks.py", 12).surface).toMatchObject({ fields: ["ui_mode"], enums: [{ field: "ui_mode", values: ["hosted"] }] });
    expect(at("app/sdks.py", 19).surface.fields).toEqual(["choices[].message.content"]);
  });

  it("declares SDKs from requirements.txt", () => {
    expect(extractCallSites(fixture).declared.map((d) => `${d.provider}:${d.package}`)).toEqual(["openai:openai", "slack:slack-sdk", "stripe:stripe", "twilio:twilio"]);
  });

  it("is matched against the same advisories as TypeScript", () => {
    const advisories = loadAdvisories(path.join(root, "advisories"));
    const { affected } = matchAdvisories(createApiLock(extractCallSites(fixture), "test"), advisories, { now: new Date("2026-10-23") });
    expect(affected.map((f) => `${f.advisory.id} ${f.callSite.file}:${f.callSite.line}`)).toEqual(
      expect.arrayContaining([
        "github-workflow-dispatch-204-to-200 app/clients.py:12",
        "quickbooks-minorversion-below-75-ignored app/clients.py:22",
        "hubspot-pipelines-v1-sunset app/clients.py:33",
        "meta-graph-v21-sunset app/clients.py:45",
        "stripe-checkout-session-ui-mode-values-renamed app/sdks.py:12",
        "slack-files-upload-retired app/sdks.py:24",
      ]),
    );
  });

  it("reads pyproject.toml dependencies: PEP 621 lists and Poetry tables", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-py-"));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src", "a.py"), 'import requests\nrequests.get("https://api.github.com/rate_limit")\n');
      writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\ndependencies = [\n  "anthropic>=0.40",\n  "requests",\n]\n\n[tool.poetry.dependencies]\nhubspot-api-client = "^9"\n');
      const result = extractCallSites(dir);
      expect(result.callSites.map((c) => c.endpoint)).toEqual(["/rate_limit"]);
      expect(result.declared.map((d) => d.package)).toEqual(["anthropic", "hubspot-api-client"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
