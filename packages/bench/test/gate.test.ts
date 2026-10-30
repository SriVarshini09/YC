import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baselineFrom, checkAgainstBaseline, gateReport, summarize, type Baseline, type InstanceResult, type Verdict } from "@shapi/bench";

const benchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = (id: string, base: Verdict, fix: Verdict, error?: string): InstanceResult => ({
  id,
  incident: "github-workflow-dispatch-204-to-200",
  advisoryId: "github-workflow-dispatch-204-to-200",
  inScope: true,
  language: "Python",
  evidenceFile: "a.py",
  ...(error ? { error } : { base, fix }),
});
const before = [result("caught", "affected", "exposed"), result("missed", "none", "none"), result("flagged-fix", "affected", "affected")];
const meta = { dataset: "APIBreak-Replay v0", datasetHash: "abc", gitSha: "0".repeat(40) };
const baseline: Baseline = baselineFrom(before, summarize(before), meta);

describe("benchmark regression gate (P-05)", () => {
  it("records every in-scope instance's verdicts and the headline rates", () => {
    expect(baseline).toMatchObject({ datasetHash: "abc", flagRecall: "2 / 3", fixedStatePrecision: "2 / 3" });
    expect(baseline.instances).toEqual([
      { id: "caught", base: "affected", fix: "exposed" },
      { id: "missed", base: "none", fix: "none" },
      { id: "flagged-fix", base: "affected", fix: "affected" },
    ]);
  });

  it("passes the same run, and reports improvements without failing", () => {
    expect(checkAgainstBaseline(baseline, before, "abc")).toMatchObject({ passed: true, lostCatches: [], newFalsePositives: [], improvements: [] });
    const better = [result("caught", "affected", "exposed"), result("missed", "affected", "none"), result("flagged-fix", "affected", "exposed")];
    const gate = checkAgainstBaseline(baseline, better, "abc");
    expect(gate.passed).toBe(true);
    expect(gate.improvements).toEqual(["missed: base none → affected", "flagged-fix: fix affected → exposed"]);
  });

  it("fails a run that lowers the catch rate, even when another instance is newly caught", () => {
    const swapped = [result("caught", "possible", "exposed"), result("missed", "affected", "none"), result("flagged-fix", "affected", "affected")];
    const gate = checkAgainstBaseline(baseline, swapped, "abc");
    // The rate is unchanged (2 / 3), but a catch was lost.
    expect(summarize(swapped).flagRecall).toMatchObject({ k: 2, n: 3 });
    expect(gate).toMatchObject({ passed: false, lostCatches: ["caught: base affected → possible"] });
  });

  it("fails a run that flags a fix commit it accepted before", () => {
    const gate = checkAgainstBaseline(baseline, [result("caught", "affected", "affected"), ...before.slice(1)], "abc");
    expect(gate).toMatchObject({ passed: false, newFalsePositives: ["caught: fix exposed → affected"] });
  });

  it("fails a run that could not scan an instance, but only reports one whose repository is gone", () => {
    const flaky = checkAgainstBaseline(baseline, [result("caught", "none", "none", "fetch failed"), ...before.slice(1)], "abc");
    expect(flaky).toMatchObject({ passed: false, unscanned: ["caught: fetch failed"] });
    const gone = checkAgainstBaseline(baseline, [result("caught", "none", "none", "download failed: 404"), ...before.slice(1)], "abc");
    expect(gone).toMatchObject({ passed: true, gone: ["caught: download failed: 404"] });
    expect(checkAgainstBaseline(baseline, before.slice(1), "abc")).toMatchObject({ passed: false, unscanned: ["caught: missing from this run"] });
  });

  it("refuses to compare with a baseline of another dataset", () => {
    const gate = checkAgainstBaseline(baseline, before, "def");
    expect(gate.passed).toBe(false);
    expect(gate.problem).toMatch(/dataset changed .* --update-baseline/);
  });

  it("writes a report that names what failed", () => {
    const after = [result("caught", "none", "exposed"), ...before.slice(1)];
    const report = gateReport(checkAgainstBaseline(baseline, after, "abc"), baseline, summarize(after));
    expect(report).toContain("## APIBreak-Replay regression gate: failed");
    expect(report).toContain("| Flag recall | 2 / 3 | 1 / 3 |");
    expect(report).toContain("- caught: base affected → none");
  });

  it("the committed baseline is for the committed dataset", async () => {
    const { createHash } = await import("node:crypto");
    const committed = JSON.parse(readFileSync(path.join(benchRoot, "baseline.json"), "utf8")) as Baseline;
    const hash = createHash("sha256").update(readFileSync(path.join(benchRoot, "datasets", "apibreak-v0.json"), "utf8")).digest("hex").slice(0, 12);
    expect(committed.datasetHash).toBe(hash);
    expect(committed.instances.length).toBeGreaterThan(0);
  });
});
