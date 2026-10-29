import type { Octokit } from "@octokit/rest";
import type { Finding, MatchResult } from "@shapi/core";
import { cell } from "./body";

export const CHECK_NAME = "SHAPI";

/** GitHub accepts at most 50 annotations per check run request. */
const ANNOTATIONS_PER_REQUEST = 50;
/** Check run summaries are capped at 65535 characters. */
const SUMMARY_LIMIT = 60_000;

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

export interface CheckRunResult {
  /**
   * "neutral" when call sites are affected (SHAPI reports, it does not block merges by default);
   * "failure" instead when the repo opts in with failOnAffected.
   */
  conclusion: "success" | "neutral" | "failure";
  output: { title: string; summary: string; annotations: CheckAnnotation[] };
}

function annotation(f: Finding, level: CheckAnnotation["annotation_level"]): CheckAnnotation {
  const a = f.advisory;
  return {
    path: f.callSite.file,
    start_line: f.callSite.line,
    end_line: f.callSite.line,
    annotation_level: level,
    title: `${a.provider}: ${a.title}`,
    message: [`${a.endpoint.method} ${a.endpoint.path} (${a.id}, effective ${a.effectiveDate})`, ...f.reasons, `Fix: ${a.migrationNote}`].join("\n"),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Turn a scan's match result into a check run conclusion, summary and line annotations. */
export function checkRunOutput(match: Pick<MatchResult, "affected" | "exposed" | "upcoming">, opts: { failOnAffected?: boolean } = {}): CheckRunResult {
  const { affected, exposed, upcoming } = match;
  const advisories = new Set(affected.map((f) => f.advisory.id));
  const title = affected.length
    ? `${plural(affected.length, "call site")} affected by ${plural(advisories.size, "API change")}`
    : "No call sites affected by known API changes";

  const lines: string[] = [];
  if (affected.length) {
    lines.push("### Affected", "", "| Advisory | Call site | Effective |", "|---|---|---|");
    for (const f of affected) lines.push(`| ${cell(f.advisory.title)} (\`${f.advisory.id}\`) | \`${f.callSite.file}:${f.callSite.line}\` | ${f.advisory.effectiveDate} |`);
    lines.push("");
  }
  if (exposed.length) lines.push(`${plural(exposed.length, "more call site")} call a changed endpoint but do not depend on what changed.`, "");
  if (upcoming.length) {
    lines.push("### Upcoming deadlines", "");
    for (const u of upcoming) lines.push(`- ${u.advisory.title}: in ${plural(u.daysUntil, "day")} (${plural(u.callSites, "call site")})`);
    lines.push("");
  }
  if (!lines.length) lines.push("SHAPI checked every third-party API call site in this commit against its advisory database.");
  let summary = lines.join("\n");
  if (summary.length > SUMMARY_LIMIT) summary = `${summary.slice(0, SUMMARY_LIMIT)}\n\n(truncated)`;

  const failOnAffected = opts.failOnAffected ?? false;
  return {
    conclusion: affected.length ? (failOnAffected ? "failure" : "neutral") : "success",
    output: {
      title,
      summary,
      annotations: [...affected.map((f) => annotation(f, failOnAffected ? "failure" : "warning")), ...exposed.map((f) => annotation(f, "notice"))],
    },
  };
}

export interface CheckTarget {
  owner: string;
  repo: string;
}

/** Start a check run on a commit; returns its id for completeCheckRun. */
export async function startCheckRun(octokit: Octokit, target: CheckTarget & { sha: string; detailsUrl?: string }): Promise<number> {
  const { data } = await octokit.rest.checks.create({
    owner: target.owner,
    repo: target.repo,
    name: CHECK_NAME,
    head_sha: target.sha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    details_url: target.detailsUrl,
  });
  return data.id;
}

/** Finish a check run. Annotations beyond the first 50 are added in further updates, as GitHub requires. */
export async function completeCheckRun(octokit: Octokit, target: CheckTarget & { checkRunId: number }, result: CheckRunResult): Promise<void> {
  const { annotations, ...output } = result.output;
  const batches: CheckAnnotation[][] = [];
  for (let i = 0; i < annotations.length; i += ANNOTATIONS_PER_REQUEST) batches.push(annotations.slice(i, i + ANNOTATIONS_PER_REQUEST));
  await octokit.rest.checks.update({
    owner: target.owner,
    repo: target.repo,
    check_run_id: target.checkRunId,
    status: "completed",
    conclusion: result.conclusion,
    completed_at: new Date().toISOString(),
    output: { ...output, annotations: batches[0] ?? [] },
  });
  for (const batch of batches.slice(1)) {
    await octokit.rest.checks.update({ owner: target.owner, repo: target.repo, check_run_id: target.checkRunId, output: { ...output, annotations: batch } });
  }
}
