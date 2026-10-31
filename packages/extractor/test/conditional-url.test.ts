import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type MatchResult } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// A base URL chosen by a ternary (sandbox or production host): seen in a real QuickBooks breakage SHAPI 0.3.1
// missed on APIBreak-Replay (theomleslie-ops/bakery-dashboard-2).
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-conditional-"));
let match: MatchResult;

beforeAll(() => {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "qb.js"),
    `const axios = require("axios");
async function fetchReport(realmId) {
  const baseUrl = process.env.QB_ENV === "sandbox"
    ? "https://sandbox-quickbooks.api.intuit.com"
    : "https://quickbooks.api.intuit.com";
  const url = \`\${baseUrl}/v3/company/\${realmId}/reports/ProfitAndLoss\`;
  const response = await axios.get(url, { params: { minorversion: 70 } });
  return response.data;
}
module.exports = { fetchReport };
`,
  );
  match = matchAdvisories(createApiLock(extractCallSites(dir), "test"), advisories, { now: new Date("2026-10-31T12:00:00Z") });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("URLs from a conditional expression", () => {
  it("resolves the host of a ternary base URL, so the call is matched", () => {
    expect(match.affected.map((f) => `${f.advisory.id} ${f.callSite.file}:${f.callSite.line}`)).toEqual(["quickbooks-minorversion-below-75-ignored src/qb.js:7"]);
  });
});
