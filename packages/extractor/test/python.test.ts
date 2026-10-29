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

// Shapes of Python code the extractor used to misread (review 3, section C).
describe("Python edge cases", () => {
  const scan = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-py-"));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
      }
      return extractCallSites(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const describeSites = (r: ReturnType<typeof scan>) => r.callSites.map((s) => `${s.client} ${s.provider} ${s.method} ${s.endpoint}`);

  it("recognizes clients constructed by bare name: from httpx import Client, from requests import Session", () => {
    const r = scan({
      "a.py":
        'from httpx import Client\nfrom requests import Session\nfrom aiohttp import ClientSession\nc = Client(base_url="https://api.hubapi.com")\ns = Session()\n' +
        'def f():\n    c.get("/crm-pipelines/v1/pipelines/deals")\n    s.get("https://api.github.com/repos/a/b")\n' +
        'async def g():\n    async with ClientSession() as session:\n        await session.post("https://api.github.com/repos/a/b/issues")\n',
    });
    expect(describeSites(r)).toEqual([
      "httpx hubspot GET /crm-pipelines/v1/pipelines/deals",
      "requests github GET /repos/a/b",
      "aiohttp github POST /repos/a/b/issues",
    ]);
  });

  it("evaluates URLs built with str.format() and the % operator", () => {
    const r = scan({
      "a.py":
        'import requests\nBASE = "https://graph.facebook.com"\ndef f(page, version):\n' +
        '    requests.get("https://graph.facebook.com/v21.0/{}/feed".format(page))\n' +
        '    requests.get("https://graph.facebook.com/v21.0/%s/posts" % page)\n' +
        '    requests.get("{0}/v{1}/{p}/photos".format(BASE, 21, p=page))\n' +
        '    requests.get("%s/v21.0/%s/videos?limit=%d" % (BASE, page, 5))\n' +
        '    requests.get("https://graph.facebook.com/v21.0/%(page)s/events" % {"page": page})\n' +
        '    requests.get("https://graph.facebook.com/v21.0/{{x}}/{}/likes".format(page))\n' +
        '    return wrapper.send("https://graph.facebook.com/v21.0/%s/insights" % page)\n',
    });
    expect(describeSites(r)).toEqual([
      "requests meta-graph GET /v21.0/{page}/feed",
      "requests meta-graph GET /v21.0/{page}/posts",
      "requests meta-graph GET /v21/{page}/photos",
      "requests meta-graph GET /v21.0/{page}/videos",
      "requests meta-graph GET /v21.0/{page}/events",
      "requests meta-graph GET /v21.0/{x}/{page}/likes",
      // not sent by a known client: a loose URL, still with the placeholder
      "url meta-graph null /v21.0/{page}/insights",
    ]);
    expect(r.callSites[3]!.surface.query).toEqual([{ name: "limit", value: "5" }]);
  });

  it("keeps the package binding after import pkg.sub", () => {
    const r = scan({ "a.py": 'import openai\nimport openai.types\ndef f():\n    openai.chat.completions.create(model="gpt-4")\n' });
    expect(r.callSites.map((s) => `${s.client} ${s.operation} ${s.method} ${s.endpoint}`)).toEqual(["openai chat.completions.create POST /v1/chat/completions"]);
  });

  it("does not take client.headers.get(...) or client.cookies.get(...) for HTTP calls", () => {
    const r = scan({
      "a.py":
        'import httpx\nc = httpx.Client(base_url="https://api.github.com")\nclass A:\n    def __init__(self):\n        self.http = httpx.Client(base_url="https://api.github.com")\n' +
        '    def f(self):\n        tok = c.headers.get("Authorization")\n        v = c.cookies.get("session")\n        p = self.http.params.get("page")\n        return self.http.get("/rate_limit")\n',
    });
    expect(describeSites(r)).toEqual(["httpx github GET /rate_limit"]);
  });

  it("marks an unknown path on a base_url client as a runtime segment", () => {
    const r = scan({ "a.py": 'import httpx\nc = httpx.Client(base_url="https://graph.facebook.com/v24.0")\ndef f(path_var):\n    return c.get(path_var)\n' });
    expect(describeSites(r)).toEqual(["httpx meta-graph GET /v24.0/{}"]);
    const advisories = loadAdvisories(path.join(root, "advisories"));
    const { possible } = matchAdvisories(createApiLock(r, "test"), advisories, { now: new Date("2026-10-23") });
    expect(possible.map((f) => f.advisory.id)).toContain("meta-graph-marketing-api-v24-sunset");
  });

  it("does not crash on SDK attributes named like Object.prototype members", () => {
    const r = scan({
      "a.py": 'from openai import OpenAI\nclient = OpenAI()\nx = client.toString()\ny = client.constructor()\nclient.chat.completions.create(model="gpt-4o")\n',
    });
    expect(r.skipped).toEqual([]);
    expect(r.callSites.map((s) => s.operation)).toEqual(["chat.completions.create"]);
  });

  it("records numeric comparisons on body fields as enum values", () => {
    const r = scan({
      "a.py":
        'import requests\ndef f(sid, msid):\n    r = requests.get(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages/{msid}.json")\n    data = r.json()\n' +
        '    if data["error_code"] == 30036 or data["error_code"] in (30046, 30047):\n        pass\n    if data["num_segments"] > 1:\n        pass\n',
    });
    expect(r.callSites[0]!.surface.enums).toEqual([{ field: "error_code", values: ["30036", "30046", "30047"] }]);
    expect(r.callSites[0]!.surface.fields).toEqual(["error_code", "num_segments"]);
  });

  it("names the provider of a host built at runtime from its fixed suffix, as the TypeScript side does", () => {
    const r = scan({
      "a.py":
        'import requests\ndef f(sub, t):\n    requests.get(f"https://{sub}.zendesk.com/api/v2/tickets/{t}")\n' +
        '    return wrapper.send(f"https://{sub}.zendesk.com/api/v2/users")\n',
    });
    expect(r.callSites.map((s) => `${s.client} ${s.provider} ${s.method} ${s.host} ${s.endpoint} ${s.resolved}`)).toEqual([
      "requests zendesk GET null /api/v2/tickets/{t} true",
      // a loose URL: provider and endpoint known, method unknown, and resolved as lockfile.ts documents
      "url zendesk null null /api/v2/users true",
    ]);
  });

  it("leaves the host null on SDK calls of a provider with per-tenant hosts", () => {
    const r = scan({ "a.py": 'from twilio.rest import Client\nclient = Client(sid, token)\nclient.messages.create(to="+1", body="x")\n' });
    expect(r.callSites.map((s) => `${s.provider} ${s.operation} ${s.host}`)).toEqual(["twilio messages.create null"]);
  });

  it("records status codes only for ==, != and in comparisons, not orderings", () => {
    const r = scan({
      "a.py":
        'import requests\ndef f():\n    r = requests.get("https://api.github.com/rate_limit")\n' +
        '    if r.status_code >= 400 or 200 <= r.status_code < 300:\n        pass\n    if r.status_code == 404 or r.status_code not in (200, 201):\n        pass\n' +
        '    data = r.json()\n    if data["state"] > "m":\n        pass\n',
    });
    expect(r.callSites[0]!.surface.statusCodes).toEqual([200, 201, 404]);
    expect(r.callSites[0]!.surface.enums).toEqual([]);
  });

  it("does not take aiohttp.web route definitions for HTTP calls", () => {
    const r = scan({
      "a.py":
        'import aiohttp\nfrom aiohttp import web\nimport aiohttp.web as aweb\nasync def handler(request):\n    async with aiohttp.ClientSession() as s:\n        await s.get("https://api.github.com/rate_limit")\n' +
        'app = web.Application()\napp.add_routes([web.get("/x", handler), web.post("/y", handler), aweb.put("/z", handler)])\napp.router.add_get("/w", handler)\n',
    });
    expect(describeSites(r)).toEqual(["aiohttp github GET /rate_limit"]);
  });

  it("reads only dependency lists from pyproject.toml, with extras in brackets", () => {
    const r = scan({
      "a.py": "x = 1\n",
      "pyproject.toml":
        '[project]\nname = "x"\nkeywords = ["stripe", "openai"]\ndependencies = [\n  "anthropic[vertex]>=0.3",\n  "twilio>=8",\n]\n\n' +
        '[project.optional-dependencies]\nai = ["openai>=1", "slack-sdk"]\n\n[dependency-groups]\ndev = [\n  "hubspot-api-client",\n]\n\n[tool.other]\nnames = ["stripe"]\n',
    });
    expect(r.declared.map((d) => d.package)).toEqual(["anthropic", "hubspot-api-client", "openai", "slack-sdk", "twilio"]);
  });
});
