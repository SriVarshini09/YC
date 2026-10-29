import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GENERATED_TEST_HEADER } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// After a SHAPI fix PR is merged, the repository holds the fixed code and the contract test SHAPI wrote.
// The test names the retired path on purpose; scanning it reopened the problem the fix had closed.
const dirs: string[] = [];
function write(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-generated-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const fixed = `import axios from "axios";
const hubspot = axios.create({ baseURL: "https://api.hubapi.com" });
export async function dealStages(token: string) {
  const resp = await hubspot.get("/crm/pipelines/2026-09/deals", { headers: { Authorization: \`Bearer \${token}\` } });
  return resp.data.results;
}
`;
const contractTest = (header: string) => `${header}
// Call site: src/crm.ts:4 (GET /crm-pipelines/v1/pipelines/deals, via axios)
function retired(req: { url: string }): boolean {
  const url = new URL(req.url, "https://shapi.invalid");
  return url.href.includes("/crm-pipelines/v1/pipelines/");
}
export { retired };
`;

describe("SHAPI's own contract tests", () => {
  it("are not scanned, so a merged fix stays fixed", () => {
    const root = write({
      "src/crm.ts": fixed,
      "test/shapi/hubspot-pipelines-v1-sunset.test.ts": contractTest(`${GENERATED_TEST_HEADER}hubspot-pipelines-v1-sunset: Pipelines API v1 retired on 2026-12-04`),
    });
    const r = extractCallSites(root);
    expect(r.callSites.map((s) => `${s.file} ${s.endpoint}`)).toEqual(["src/crm.ts /crm/pipelines/2026-09/deals"]);
    expect(r.filesScanned).toBe(1);
    expect(r.skipped).toEqual([]);
  });

  it("are recognized with a byte order mark", () => {
    const root = write({ "test/shapi/a.test.ts": `\uFEFF${contractTest(`${GENERATED_TEST_HEADER}a: A`)}` });
    expect(extractCallSites(root).callSites).toEqual([]);
  });

  it("only by the header: the user's own test with the same code is still scanned", () => {
    const root = write({ "test/shapi/mine.test.ts": contractTest("// my own test") });
    expect(extractCallSites(root).callSites.map((s) => s.endpoint)).toEqual(["/crm-pipelines/v1/pipelines"]);
  });
});
