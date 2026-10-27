import { structuredPatch } from "diff";
import type { Advisory } from "@shapi/core";
import type { FixRepair, FixTestRun } from "@shapi/db";
import type { LockedCallSite } from "@shapi/core";
import type { RepairResult, TestRun } from "@shapi/repair";

/** Diff lines kept per file; the PR on GitHub has the whole change. */
export const DIFF_LINE_LIMIT = 400;
/** Characters of test output kept per run. */
const OUTPUT_LIMIT = 4_000;

interface RepairedSite {
  callSite: Pick<LockedCallSite, "file" | "line" | "method" | "endpoint">;
  result: RepairResult;
}

/**
 * What the web app shows for a fix PR: each file's unified diff, and for every call site the contract
 * test's run before the change (it fails) and after it (it passes). Sized to fit a row, not a repository.
 */
export function summarizeRepair(input: { advisory: Advisory; sites: RepairedSite[]; changes: RepairResult["changes"]; method?: "recipe" | "llm"; sandbox?: string }, now = new Date()): FixRepair {
  const passedRun = (attempts: { outcome: string; run?: TestRun }[]) => attempts.find((a) => a.outcome === "passed")?.run;
  const method = input.method ?? "recipe";
  return {
    method,
    ...(input.advisory.recipeId && method !== "llm" ? { recipeId: input.advisory.recipeId } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    verifiedAt: now.toISOString(),
    sites: input.sites.map((s) => ({
      file: s.callSite.file,
      line: s.callSite.line,
      method: s.callSite.method,
      endpoint: s.callSite.endpoint,
      status: s.result.status,
      ...(s.result.reason ? { reason: s.result.reason } : {}),
      ...(s.result.test ? { test: s.result.test.file } : {}),
      ...(s.result.baseline ? { before: testRun(s.result.baseline) } : {}),
      ...(passedRun(s.result.attempts) ? { after: testRun(passedRun(s.result.attempts)!) } : {}),
    })),
    changes: input.changes.map((c) => ({ file: c.file, kind: c.before === "" ? "added" : "modified", ...unifiedDiff(c.file, c.before, c.after) })),
  };
}

function testRun(run: TestRun): FixTestRun {
  const m = /Tests\s+([^\n]+?)\s*\(\d+\)/.exec(run.output);
  const output = run.output.trim();
  return { passed: run.passed, tests: m ? m[1]!.trim() : run.passed ? "passed" : "failed", output: output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output };
}

/** A unified diff of one file with 3 lines of context, cut at DIFF_LINE_LIMIT lines. */
export function unifiedDiff(file: string, before: string, after: string): { diff: string; truncated: boolean } {
  const patch = structuredPatch(file, file, before, after, "", "", { context: 3 });
  const lines: string[] = [];
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    lines.push(...h.lines);
  }
  const truncated = lines.length > DIFF_LINE_LIMIT;
  return { diff: (truncated ? lines.slice(0, DIFF_LINE_LIMIT) : lines).join("\n"), truncated };
}
