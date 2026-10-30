import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories } from "@shapi/core";
import { runBacktestCase, type BacktestCase } from "@shapi/bench";

// Execution plan P-11: the canary back-test. The dataset is reconstructions; this pins what the canary makes of them.
const here = path.dirname(fileURLToPath(import.meta.url));
const dataset = JSON.parse(readFileSync(path.join(here, "..", "datasets", "canary-backtest.json"), "utf8")) as { cycleMinutes: number; cases: BacktestCase[] };
const run = (id: string) => runBacktestCase(dataset.cases.find((c) => c.id === id)!, dataset.cycleMinutes);

describe("canary back-test (P-11)", () => {
  it("takes each expected classification from the reviewed advisory it names", () => {
    const advisories = new Map(loadAdvisories(path.join(here, "..", "..", "..", "advisories")).map((a) => [a.id, a]));
    for (const c of dataset.cases.filter((x) => x.expected.advisory)) {
      const a = advisories.get(c.expected.advisory!)!;
      expect({ changeClass: a.changeClass, severity: a.severity }, c.id).toEqual({ changeClass: c.expected.changeClass, severity: c.expected.severity });
    }
  });

  it("classifies both GitHub workflow_dispatch changes as critical status-code changes, seen one cycle after", () => {
    for (const id of ["github-workflow-dispatch-204-to-200", "github-workflow-dispatch-revert-2026-02-19"]) {
      expect(run(id)).toMatchObject({ classified: { changeClass: "status-code", severity: "critical", breaking: true }, classMatches: true, severityMatches: true, probe: "github:workflow-dispatch", cyclesNow: 1, cyclesWithProbe: 1 });
    }
  });

  it("classifies Reddit's 403 as an auth change, rated critical where the reviewed advisory says high", () => {
    expect(run("reddit-logged-out-json-403")).toMatchObject({ classified: { changeClass: "auth", severity: "critical" }, classMatches: true, severityMatches: false, probe: null, cyclesNow: null, cyclesWithProbe: 1 });
  });

  it("documents the two gaps: QuickBooks needs an old-minorversion probe, Slack a burst probe and a rate-limit class", () => {
    const qbo = run("quickbooks-minorversion-below-75-ignored");
    // The shape evidence is a field change; the reviewed advisory frames it as a version sunset.
    expect(qbo).toMatchObject({ classified: { changeClass: "field-rename", breaking: true }, classMatches: false, probe: null, cyclesWithProbe: 1 });
    expect(qbo.gap).toContain("minorversion=65");
    const slack = run("slack-non-marketplace-rate-limit");
    // 429 is availability to the diff, so nothing is drafted even when a probe sees it.
    expect(slack).toMatchObject({ classified: { changeClass: null, breaking: false }, classMatches: false, probe: null });
    expect(slack.classified.changes).toContain("informational: status 200 → 429");
    expect(slack.gap).toContain("burst probe");
  });

  it("a probe that receives the same response on both sides never sees the change", () => {
    const qbo = dataset.cases.find((c) => c.id === "quickbooks-minorversion-below-75-ignored")!;
    // Give it a probe like today's (current minorversion): it receives the new fields before and after.
    expect(runBacktestCase({ ...qbo, probe: { id: "quickbooks:query" } }, dataset.cycleMinutes)).toMatchObject({ cyclesNow: null, cyclesWithProbe: 1 });
  });
});
