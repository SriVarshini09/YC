import { describe, expect, it } from "vitest";
import type { Advisory, Finding, LockedCallSite } from "@shapi/core";
import { evidenceIn, instanceFromRow, parseCsv, summarize, verdictFor, wilson, type InstanceResult } from "@shapi/bench";

const row = {
  incident: "github-workflow-dispatch-204-to-200",
  class: "accept-200",
  repo: "stategraph/stategraph",
  date: "2025-12-19",
  lag_days: "0",
  url: "https://github.com/stategraph/stategraph/commit/e34b4c3a8559dfae667e28cab1863763880e8296",
  subject: "Merge pull request #1054",
};

describe("instances", () => {
  it("parse the quoted CSV, commas and quotes inside fields included", () => {
    const rows = parseCsv('incident,subject\n"a","fix, then ""retry"""\r\n"b","x"\n');
    expect(rows).toEqual([
      { incident: "a", subject: 'fix, then "retry"' },
      { incident: "b", subject: "x" },
    ]);
  });

  it("score a breakage fix against its advisory", () => {
    const i = instanceFromRow(row);
    expect(i).toMatchObject({
      id: "github-workflow-dispatch-204-to-200__stategraph__stategraph",
      fixCommit: "e34b4c3a8559dfae667e28cab1863763880e8296",
      advisoryId: "github-workflow-dispatch-204-to-200",
      inScope: true,
      lagDays: 0,
    });
  });

  it("keep a change SHAPI has no advisory for, out of scope with the reason", () => {
    const i = instanceFromRow({ ...row, class: "empty-204" });
    expect(i.inScope).toBe(false);
    expect(i.advisoryId).toBeNull();
    expect(i.outOfScopeReason).toMatch(/no advisory/);
  });

  it("take evidence only from a removed line that shows the old behavior", () => {
    const qbo = "quickbooks-minorversion-below-75-ignored";
    const patch = (p: string) => [{ filename: "src/qb.py", patch: p }];
    expect(evidenceIn(patch('-  params={"query": q, "minorversion": "65"}\n+  params={"query": q, "minorversion": "75"}'), qbo)).toEqual({
      file: "src/qb.py",
      removed: 'params={"query": q, "minorversion": "65"}',
    });
    expect(evidenceIn(patch("-  url = `${base}/query?minorversion=70`"), qbo)).toBeDefined();
    expect(evidenceIn(patch("-  minorversion: 70,"), qbo)).toBeDefined();
    // the fix added a minor version where there was none: nothing shows the old code was affected
    expect(evidenceIn(patch("+  url = `${base}/query?minorversion=75`"), qbo)).toBeUndefined();
    expect(evidenceIn(patch("-  url = `${base}/query?minorversion=75`"), qbo)).toBeUndefined();
    expect(evidenceIn(patch("-  minorversion=750"), qbo)).toBeUndefined();
    expect(evidenceIn(patch("-    if r.status_code == 204:"), "github-workflow-dispatch-204-to-200")).toBeDefined();
    expect(evidenceIn(patch("-    if r.status_code == 204:"), "unknown-advisory")).toBeUndefined();
  });

  it("refuse a label with no scoring rule, and a URL that is not a commit", () => {
    expect(() => instanceFromRow({ ...row, class: "new-label" })).toThrow(/no scoring rule/);
    expect(() => instanceFromRow({ ...row, url: "https://github.com/stategraph/stategraph" })).toThrow(/not a commit URL/);
  });
});

describe("metrics", () => {
  it("give the Wilson 95% interval", () => {
    expect(wilson(5, 10)).toEqual({ k: 5, n: 10, rate: 0.5, low: 0.237, high: 0.763 });
    expect(wilson(0, 10)).toMatchObject({ rate: 0, low: 0, high: 0.278 });
    expect(wilson(0, 0)).toBeNull();
  });

  it("take the strongest verdict for the advisory", () => {
    const finding = (id: string) => ({ advisory: { id } as Advisory, callSite: {} as LockedCallSite, reasons: [] }) as Finding;
    expect(verdictFor({ affected: [finding("a")], possible: [finding("a")], exposed: [] }, "a")).toBe("affected");
    expect(verdictFor({ affected: [finding("b")], possible: [finding("a")], exposed: [] }, "a")).toBe("possible");
    expect(verdictFor({ affected: [], possible: [], exposed: [finding("a")] }, "a")).toBe("exposed");
    expect(verdictFor({ affected: [finding("b")], possible: [], exposed: [] }, "a")).toBe("none");
  });

  it("count recall on base commits and precision on fix commits, in scope only", () => {
    const r = (id: string, base: InstanceResult["base"], fix: InstanceResult["fix"], extra: Partial<InstanceResult> = {}): InstanceResult => ({
      id, incident: "x", advisoryId: "a", inScope: true, language: "Python", evidenceFile: "src/a.py", base, fix, ...extra,
    });
    const s = summarize([
      r("1", "affected", "none"),
      r("2", "affected", "affected"),
      r("3", "possible", "possible"),
      r("4", "none", "none", { evidenceFile: ".github/workflows/a.yml" }),
      r("5", undefined, undefined, { error: "download failed: 404" }),
      r("6", undefined, undefined, { inScope: false }),
    ]);
    expect(s).toMatchObject({ instances: 6, inScope: 5, scored: 4, errors: 1 });
    expect(s.flagRecall).toMatchObject({ k: 2, n: 4 });
    expect(s.flagRecallWithPossible).toMatchObject({ k: 3, n: 4 });
    expect(s.fixedStatePrecision).toMatchObject({ k: 3, n: 4 });
    expect(s.flagRecallScannedFiles).toMatchObject({ k: 2, n: 3 });
  });
});
