import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdvisorySchema, createApiLock, matchAdvisories, type Advisory } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { runPythonRecipe } from "../src/python/recipes";

// Execution plan U-03: apply-fix and status-code-accept-set on Python call sites.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories");
const advisory = (id: string): Advisory => AdvisorySchema.parse(JSON.parse(readFileSync(path.join(root, `${id}.json`), "utf8")));
const qbo = advisory("quickbooks-minorversion-below-75-ignored");
const dispatch = advisory("github-workflow-dispatch-204-to-200");

let dir: string;
beforeAll(async () => {
  await loadPythonParser();
  dir = mkdtempSync(path.join(os.tmpdir(), "shapi-py-recipes-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The recipe's output for every call site the advisory flags in this Python file, as SHAPI's scan finds them. */
function fix(a: Advisory, source: string): { after: string; notes: string[] }[] {
  const repo = mkdtempSync(path.join(dir, "repo-"));
  mkdirSync(path.join(repo, "app"));
  writeFileSync(path.join(repo, "app", "client.py"), source);
  const lock = createApiLock(extractCallSites(repo), "t");
  const affected = matchAdvisories(lock, [a], { now: new Date("2026-10-30") }).affected;
  return affected.map((f) => {
    const out = runPythonRecipe(a, f.callSite, source);
    if (out.status !== "applied") throw new Error(`${out.status}: ${"reason" in out ? out.reason : ""}`);
    return { after: out.change.after, notes: out.change.notes };
  });
}

describe("apply-fix in Python", () => {
  it("moves minorversion in an f-string URL that urllib sends (the QuickBooks benchmark's case)", () => {
    const source = [
      "import urllib.request",
      "",
      "def company_info(realm_id, token):",
      "    info_url = (",
      '        f"https://sandbox-quickbooks.api.intuit.com/v3/company/{realm_id}"',
      '        f"/companyinfo/{realm_id}?minorversion=65"',
      "    )",
      '    req = urllib.request.Request(info_url, headers={"Authorization": f"Bearer {token}"})',
      "    with urllib.request.urlopen(req) as resp:",
      "        return resp.status",
      "",
    ].join("\n");
    const [out] = fix(qbo, source);
    expect(out!.after).toContain('f"/companyinfo/{realm_id}?minorversion=75"');
    expect(out!.after.replace("minorversion=75", "minorversion=65")).toBe(source);
    expect(out!.notes[0]).toContain("app/client.py:6");
  });

  it("moves minorversion in a requests params dict, and in a URL built from a module constant; leaves 75 and above alone", () => {
    const source = [
      "import requests",
      'BASE = "https://quickbooks.api.intuit.com/v3/company"',
      "",
      "def invoices(realm, token):",
      '    r = requests.get(f"{BASE}/{realm}/query", params={"query": "select * from Invoice", "minorversion": 65})',
      "    return r.json()",
      "",
      "def customers(realm):",
      '    url = BASE + "/" + realm + "/query?minorversion=4"',
      "    return requests.get(url).json()",
      "",
      "def items(realm):",
      '    return requests.get(f"{BASE}/{realm}/item?minorversion=75").json()',
      "",
    ].join("\n");
    const outs = fix(qbo, source);
    expect(outs).toHaveLength(2);
    expect(outs.map((o) => o.after).find((a) => a.includes('"minorversion": 75'))).toBeDefined();
    expect(outs.map((o) => o.after).find((a) => a.includes('"/query?minorversion=75"'))).toBeDefined();
  });
});

describe("status-code-accept-set in Python", () => {
  it("makes a comparison with 204 also accept 200, for the response of the call only", () => {
    const source = [
      "import requests",
      "",
      "def dispatch(owner, repo, token):",
      '    other = requests.get("https://example.com/health")',
      '    resp = requests.post(f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/deploy.yml/dispatches", json={"ref": "main"})',
      "    if resp.status_code != 204:",
      '        raise RuntimeError("dispatch failed")',
      "    if other.status_code != 204:",
      "        pass",
      "    return resp.status_code in (201, 204)",
      "",
    ].join("\n");
    const [out] = fix(dispatch, source);
    expect(out!.after).toContain("if resp.status_code not in (200, 204):");
    expect(out!.after).toContain("if other.status_code != 204:");
    expect(out!.after).toContain("return resp.status_code in (200, 201, 204)");
  });

  it("finds nothing to change when the code already accepts the new code", () => {
    const source = [
      "import requests",
      "",
      "def dispatch(owner, repo):",
      '    resp = requests.post(f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/deploy.yml/dispatches")',
      "    return resp.ok",
      "",
    ].join("\n");
    const lock = createApiLock(extractCallSites(mkRepo(source)), "t");
    const site = lock.callSites.find((s) => s.provider === "github")!;
    expect(runPythonRecipe(dispatch, site, source)).toMatchObject({ status: "no-change" });
  });
});

function mkRepo(source: string): string {
  const repo = mkdtempSync(path.join(dir, "repo-"));
  writeFileSync(path.join(repo, "client.py"), source);
  return repo;
}

describe("SHAPI's generated Python tests", () => {
  it("are not scanned as call sites, though they name the retired request", () => {
    const repo = mkRepo('# Generated by SHAPI for advisory quickbooks-minorversion-below-75-ignored: x\nURL = "https://quickbooks.api.intuit.com/v3/company/1/query?minorversion=4"\n');
    writeFileSync(path.join(repo, "real.py"), 'URL = "https://quickbooks.api.intuit.com/v3/company/1/query?minorversion=4"\n');
    expect(extractCallSites(repo).callSites.map((s) => s.file)).toEqual(["real.py"]);
  });
});
