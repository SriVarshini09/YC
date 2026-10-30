import type { InstanceResult, Summary, Verdict } from "./metrics";

/**
 * The benchmark as the matcher's regression suite (execution plan P-05). baseline.json holds the verdicts of the
 * last accepted run; CI scans again and fails when an instance SHAPI caught is no longer caught, or a fix commit
 * SHAPI accepted is flagged again. Instances are compared one by one, so a lost catch cannot hide behind a new one.
 */
export interface Baseline {
  dataset: string;
  datasetHash: string;
  /** The SHAPI commit the baseline was run at. */
  gitSha: string;
  flagRecall: string;
  fixedStatePrecision: string;
  instances: { id: string; base: Verdict | null; fix: Verdict | null }[];
}

export interface GateResult {
  passed: boolean;
  /** Caught at the base commit in the baseline (affected), not now. */
  lostCatches: string[];
  /** Not flagged at the fix commit in the baseline, flagged now: a new false positive. */
  newFalsePositives: string[];
  /** Caught now and not in the baseline, or no longer flagged at the fix commit: update the baseline to keep them. */
  improvements: string[];
  /** Could not be scanned for a reason other than the repository or commit being gone. The run must be repeated. */
  unscanned: string[];
  /** The repository or commit no longer exists (404). Reported, not failed: P-07 archives these. */
  gone: string[];
  /** Why the gate cannot compare at all (a different dataset), or empty. */
  problem?: string;
}

const ratio = (r: { k: number; n: number } | null) => (r ? `${r.k} / ${r.n}` : "n/a");

/** The baseline for a run: every scored or errored in-scope instance's verdicts. */
export function baselineFrom(results: InstanceResult[], summary: Summary, meta: { dataset: string; datasetHash: string; gitSha: string }): Baseline {
  return {
    ...meta,
    flagRecall: ratio(summary.flagRecall),
    fixedStatePrecision: ratio(summary.fixedStatePrecision),
    instances: results.filter((r) => r.inScope).map((r) => ({ id: r.id, base: r.base ?? null, fix: r.fix ?? null })),
  };
}

const GONE = /download failed: 404/;

export function checkAgainstBaseline(baseline: Baseline, results: InstanceResult[], datasetHash: string): GateResult {
  const gate: GateResult = { passed: false, lostCatches: [], newFalsePositives: [], improvements: [], unscanned: [], gone: [] };
  if (baseline.datasetHash !== datasetHash) {
    gate.problem = `the dataset changed (baseline ${baseline.datasetHash}, now ${datasetHash}): run the benchmark with --update-baseline and commit baseline.json`;
    return gate;
  }
  const now = new Map(results.filter((r) => r.inScope).map((r) => [r.id, r]));
  for (const before of baseline.instances) {
    const after = now.get(before.id);
    if (!after) {
      gate.unscanned.push(`${before.id}: missing from this run`);
      continue;
    }
    if (after.error) {
      (GONE.test(after.error) ? gate.gone : gate.unscanned).push(`${before.id}: ${after.error}`);
      continue;
    }
    if (before.base === "affected" && after.base !== "affected") gate.lostCatches.push(`${before.id}: base ${before.base} → ${after.base}`);
    if (before.base !== "affected" && after.base === "affected") gate.improvements.push(`${before.id}: base ${before.base ?? "-"} → affected`);
    if (before.fix !== "affected" && after.fix === "affected") gate.newFalsePositives.push(`${before.id}: fix ${before.fix ?? "-"} → affected`);
    if (before.fix === "affected" && after.fix !== "affected") gate.improvements.push(`${before.id}: fix affected → ${after.fix}`);
  }
  gate.passed = gate.lostCatches.length === 0 && gate.newFalsePositives.length === 0 && gate.unscanned.length === 0;
  return gate;
}

/** The gate's result as Markdown, for the CI job summary and the log. */
export function gateReport(gate: GateResult, baseline: Baseline, summary: Summary): string {
  const lines = [
    `## APIBreak-Replay regression gate: ${gate.passed ? "passed" : "failed"}`,
    "",
    `| | Baseline (${baseline.gitSha.slice(0, 7)}) | This run |`,
    "|---|---|---|",
    `| Flag recall | ${baseline.flagRecall} | ${ratio(summary.flagRecall)} |`,
    `| Fixed-state precision | ${baseline.fixedStatePrecision} | ${ratio(summary.fixedStatePrecision)} |`,
  ];
  if (gate.problem) lines.push("", `**${gate.problem}**`);
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push("", `**${title}**`, ...items.map((i) => `- ${i}`));
  };
  section("Lost catches (fails the gate)", gate.lostCatches);
  section("New false positives (fails the gate)", gate.newFalsePositives);
  section("Could not be scanned (fails the gate: run it again)", gate.unscanned);
  section("Repository or commit gone (reported only)", gate.gone);
  section("Improvements: run with --update-baseline and commit baseline.json to keep them", gate.improvements);
  return lines.join("\n");
}
