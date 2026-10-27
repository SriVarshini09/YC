import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories } from "@shapi/core";
import type { RepairResult } from "@shapi/repair";
import { DIFF_LINE_LIMIT, summarizeRepair, unifiedDiff } from "../src/jobs/repair-summary";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;

const before = `export async function dispatch() {\n  const res = await fetch(url, { method: "POST" });\n  if (res.status !== 204) throw new Error("dispatch failed");\n}\n`;
const after = before.replace('res.status !== 204', "![200, 204].includes(res.status)");

const result: RepairResult = {
  status: "fixed",
  method: "recipe",
  sandbox: "e2b:sbx_123",
  changes: [
    { file: "src/deploy.ts", before, after, notes: ["accept 200 as well as 204"] },
    { file: "test/shapi/github-workflow-dispatch-204-to-200.test.ts", before: "", after: "describe('contract', () => {});\n", notes: [] },
  ],
  test: { file: "test/shapi/github-workflow-dispatch-204-to-200.test.ts", content: "..." },
  baseline: { passed: false, exitCode: 1, output: "FAIL  test/shapi/x.test.ts\n Tests  1 failed (1)\n" },
  attempts: [{ method: "recipe", outcome: "passed", detail: "status-code-accept-set", run: { passed: true, exitCode: 0, output: " Tests  1 passed (1)\n" } }],
};

describe("repair summary for the web app", () => {
  it("keeps the diff per file and the test run before and after, red to green", () => {
    const summary = summarizeRepair({ advisory, sites: [{ callSite: { file: "src/deploy.ts", line: 3, method: "POST", endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" }, result }], changes: result.changes, method: "recipe", sandbox: "e2b:sbx_123" }, new Date("2026-10-23T10:00:00Z"));
    expect(summary).toMatchObject({ method: "recipe", recipeId: "status-code-accept-set", sandbox: "e2b:sbx_123", verifiedAt: "2026-10-23T10:00:00.000Z" });
    expect(summary.sites).toEqual([
      expect.objectContaining({
        file: "src/deploy.ts",
        line: 3,
        status: "fixed",
        test: "test/shapi/github-workflow-dispatch-204-to-200.test.ts",
        before: { passed: false, tests: "1 failed", output: expect.stringContaining("FAIL") },
        after: { passed: true, tests: "1 passed", output: "Tests  1 passed (1)" },
      }),
    ]);
    expect(summary.changes.map((c) => [c.file, c.kind, c.truncated])).toEqual([
      ["src/deploy.ts", "modified", false],
      ["test/shapi/github-workflow-dispatch-204-to-200.test.ts", "added", false],
    ]);
    expect(summary.changes[0]!.diff).toContain('-  if (res.status !== 204) throw new Error("dispatch failed");');
    expect(summary.changes[0]!.diff).toContain('+  if (![200, 204].includes(res.status)) throw new Error("dispatch failed");');
    expect(summary.changes[0]!.diff.startsWith("@@ -1,4 +1,4 @@")).toBe(true);
  });

  it("cuts a long diff at the line limit and says so", () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const changed = big.replace(/line (\d+)/g, "changed $1");
    const d = unifiedDiff("big.ts", big, changed);
    expect(d.truncated).toBe(true);
    expect(d.diff.split("\n")).toHaveLength(DIFF_LINE_LIMIT);
  });
});
