import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdvisorySchema, createApiLock, matchAdvisories, type Advisory } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { RECIPES, repairCallSite } from "@shapi/repair";
import { pythonCommand } from "../src/runner";

// Execution plan U-03: a Python call site repaired test-first, with a stdlib contract test that fails before the fix.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories");
const advisory = (id: string): Advisory => AdvisorySchema.parse(JSON.parse(readFileSync(path.join(root, `${id}.json`), "utf8")));
const hasPython = spawnSync(pythonCommand(), ["--version"]).status === 0;
const hasRequests = hasPython && spawnSync(pythonCommand(), ["-c", "import requests"]).status === 0;

let dir: string;
beforeAll(async () => {
  await loadPythonParser();
  dir = mkdtempSync(path.join(os.tmpdir(), "shapi-py-agent-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function repair(a: Advisory, file: string, source: string) {
  const repo = mkdtempSync(path.join(dir, "repo-"));
  mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(repo, file), source);
  const lock = createApiLock(extractCallSites(repo), "t");
  const [finding] = matchAdvisories(lock, [a], { now: new Date("2026-10-30") }).affected;
  if (!finding) throw new Error("no affected call site");
  return repairCallSite({ repoDir: repo, advisory: a, callSite: finding.callSite, recipes: RECIPES });
}

describe.runIf(hasPython)("repairing Python", () => {
  it("fixes a QuickBooks call that urllib sends with minorversion=65, behind credentials from the environment and a token refresh", async () => {
    // The shape of the APIBreak-Replay instance hfscdogg/outgrow: environment credentials, a token refresh, then the call.
    const source = [
      "import json",
      "import os",
      "import urllib.request",
      "",
      "",
      "def probe_qbo(verbose):",
      '    client_id = os.environ.get("QBO_CLIENT_ID", "")',
      '    realm_id = os.environ.get("QBO_REALM_ID", "")',
      "    if not all([client_id, realm_id]):",
      "        return True",
      "    try:",
      '        req = urllib.request.Request("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", data=b"x", method="POST")',
      "        with urllib.request.urlopen(req, timeout=15) as resp:",
      "            body = json.loads(resp.read())",
      '        access_token = body.get("access_token")',
      "        if not access_token:",
      "            return False",
      "        info_url = (",
      '            f"https://sandbox-quickbooks.api.intuit.com/v3/company/{realm_id}"',
      '            f"/companyinfo/{realm_id}?minorversion=65"',
      "        )",
      '        req2 = urllib.request.Request(info_url, headers={"Authorization": f"Bearer {access_token}"})',
      "        with urllib.request.urlopen(req2, timeout=15) as resp2:",
      "            return resp2.status == 200",
      "    except Exception:",
      "        return False",
      "",
    ].join("\n");
    const result = await repair(advisory("quickbooks-minorversion-below-75-ignored"), "scripts/smoke.py", source);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("fixed");
    expect(result.method).toBe("recipe");
    expect(result.baseline?.output).toMatch(/SHAPI breakage: probe_qbo\(\) sends the retired request GET https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/shapi-test\/companyinfo\/shapi-test\?minorversion=65/);
    expect(result.changes[0]!.after).toContain("?minorversion=75");
    expect(result.changes[1]!.file).toBe("test/shapi/test_quickbooks_minorversion_below_75_ignored.py");
    expect(result.typecheck?.status).toBe("skipped");
    expect(result.undo?.status).toBe("passed");
  }, 60_000);

  it.runIf(hasRequests)("fixes a status check that only accepts 204 when GitHub now answers 200 (requests)", async () => {
    const source = [
      "import requests",
      "",
      'API = "https://api.github.com"',
      "",
      "",
      "def dispatch(owner, repo, token):",
      '    resp = requests.post(f"{API}/repos/{owner}/{repo}/actions/workflows/deploy.yml/dispatches", json={"ref": "main"})',
      "    if resp.status_code != 204:",
      '        raise RuntimeError("dispatch failed")',
      "    return True",
      "",
    ].join("\n");
    const result = await repair(advisory("github-workflow-dispatch-204-to-200"), "deploy.py", source);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("fixed");
    expect(result.baseline?.output).toMatch(/SHAPI breakage: dispatch\(\) fails when the API answers 200 instead of 204/);
    expect(result.changes[0]!.after).toContain("if resp.status_code not in (200, 204):");
  }, 60_000);

  it("says the call is untestable when the function returns before it, instead of claiming a fix", async () => {
    const source = [
      "import urllib.request",
      "",
      "def company(realm_id):",
      "    if realm_id:",
      "        return None",
      '    return urllib.request.urlopen(f"https://quickbooks.api.intuit.com/v3/company/{realm_id}/companyinfo/1?minorversion=4")',
      "",
    ].join("\n");
    const result = await repair(advisory("quickbooks-minorversion-below-75-ignored"), "qbo.py", source);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/^company\(\) did not call the endpoint with placeholder arguments \(it returned None\)/);
  }, 60_000);
});
