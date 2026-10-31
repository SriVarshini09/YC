import type { Dataset } from "./instances";
import { wilson, type InstanceResult, type Rate } from "./metrics";

/**
 * The APIBreak-Replay leaderboard (execution plan P-15): any tool's verdicts on the scored instances, scored the same
 * way as SHAPI's. A submission says, for every scored instance, whether the tool flagged the code at the base commit
 * (before the human fix) and at the fix commit. See SUBMISSIONS.md for the format.
 */

export type Verdict = "flagged" | "clear" | "error";

export interface Submission {
  tool: string;
  version: string;
  /** The tool's home page or repository. */
  url: string;
  /** Who ran it: a person, an organization, or "SHAPI maintainers". */
  submittedBy: string;
  runAt: string;
  /** The dataset file's name and the first 12 hex of its SHA-256, as `bench:run` prints them. */
  dataset: string;
  datasetHash: string;
  /** How to reproduce the run. */
  command: string;
  results: { id: string; base: Verdict; fix: Verdict }[];
}

export interface LeaderboardRow {
  tool: string;
  version: string;
  url: string;
  submittedBy: string;
  runAt: string;
  /** Flagged at the base commit. */
  recall: Rate | null;
  /** Clear at the fix commit. */
  fixedStatePrecision: Rate | null;
  errors: number;
}

const VERDICTS = new Set<Verdict>(["flagged", "clear", "error"]);

/** The instances a submission must cover: in scope, with both commits. */
export function scoredIds(dataset: Dataset): string[] {
  return dataset.instances.filter((i) => i.inScope && i.advisoryId && i.baseCommit).map((i) => i.id);
}

/** What is wrong with a submission; empty when it can be scored. */
export function submissionProblems(s: Submission, dataset: { name: string; hash: string; scored: string[] }): string[] {
  const problems: string[] = [];
  for (const key of ["tool", "version", "url", "submittedBy", "runAt", "command"] as const) {
    if (typeof s[key] !== "string" || !s[key].trim()) problems.push(`${key} is missing`);
  }
  if (typeof s.url === "string" && !/^https:\/\//.test(s.url)) problems.push("url must be https");
  if (typeof s.runAt === "string" && Number.isNaN(Date.parse(s.runAt))) problems.push("runAt is not a date");
  if (s.dataset !== dataset.name || s.datasetHash !== dataset.hash) problems.push(`scored against ${s.dataset}@${s.datasetHash}, not ${dataset.name}@${dataset.hash}`);
  if (!Array.isArray(s.results)) return [...problems, "results is not a list"];
  const seen = new Set<string>();
  for (const r of s.results) {
    if (!dataset.scored.includes(r.id)) problems.push(`${r.id}: not a scored instance`);
    if (seen.has(r.id)) problems.push(`${r.id}: listed twice`);
    seen.add(r.id);
    if (!VERDICTS.has(r.base) || !VERDICTS.has(r.fix)) problems.push(`${r.id}: base and fix must each be flagged, clear or error`);
  }
  for (const id of dataset.scored) if (!seen.has(id)) problems.push(`${id}: missing`);
  return problems;
}

/** One leaderboard row. Errors count against the tool: an instance it could not run is not a catch. */
export function scoreSubmission(s: Submission): LeaderboardRow {
  const n = s.results.length;
  return {
    tool: s.tool,
    version: s.version,
    url: s.url,
    submittedBy: s.submittedBy,
    runAt: s.runAt,
    recall: wilson(s.results.filter((r) => r.base === "flagged").length, n),
    fixedStatePrecision: wilson(s.results.filter((r) => r.fix === "clear").length, n),
    errors: s.results.filter((r) => r.base === "error" || r.fix === "error").length,
  };
}

/** SHAPI's own `bench:run` results as a submission: `affected` is flagged, `possible` is not. */
export function shapiSubmission(run: { shapiVersion: string; runAt: string; gitSha: string; dataset: string; datasetHash: string; results: InstanceResult[] }, scored: string[]): Submission {
  const verdict = (v: string | null | undefined): Verdict => (v === "affected" ? "flagged" : v === "error" || v === "unavailable" || v == null ? "error" : "clear");
  return {
    tool: "SHAPI",
    version: run.shapiVersion,
    url: "https://shapi.dev",
    submittedBy: "SHAPI maintainers",
    runAt: run.runAt,
    dataset: run.dataset,
    datasetHash: run.datasetHash,
    command: `pnpm --filter @shapi/bench bench:run (at ${run.gitSha.slice(0, 7)})`,
    results: run.results.filter((r) => scored.includes(r.id)).map((r) => ({ id: r.id, base: verdict(r.base), fix: verdict(r.fix) })),
  };
}

const pct = (r: Rate | null) => (r ? `${Math.round(r.rate * 100)}% (${r.k}/${r.n}, 95% CI ${Math.round(r.low * 100)}–${Math.round(r.high * 100)}%)` : "n/a");

/** The leaderboard as a Markdown table, best recall first. */
export function leaderboardTable(rows: LeaderboardRow[]): string {
  const sorted = [...rows].sort((a, b) => (b.recall?.rate ?? 0) - (a.recall?.rate ?? 0) || (b.fixedStatePrecision?.rate ?? 0) - (a.fixedStatePrecision?.rate ?? 0) || a.tool.localeCompare(b.tool));
  const lines = ["| Tool | Version | Flag recall | Fixed-state precision | Errors | Submitted by | Run |", "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const r of sorted) lines.push(`| [${r.tool}](${r.url}) | ${r.version} | ${pct(r.recall)} | ${pct(r.fixedStatePrecision)} | ${r.errors} | ${r.submittedBy} | ${r.runAt.slice(0, 10)} |`);
  return lines.join("\n");
}
