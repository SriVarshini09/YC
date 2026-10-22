import type { Advisory, LockedCallSite } from "@shapi/core";
import type { RepairResult, TestRun } from "@shapi/repair";

export interface PrBodyInput {
  advisory: Advisory;
  callSite: LockedCallSite;
  result: RepairResult;
  /** Affected call sites for this advisory in the repo (blast radius). */
  affectedInRepo: number;
  /** Where the before/after shapes came from, for example "canary:github:token" or a recording file. */
  shapeSource: string;
}

export function prTitle(advisory: Advisory): string {
  return `SHAPI: ${advisory.title}`;
}

export function prBranch(advisory: Advisory): string {
  return `shapi/${advisory.id}`;
}

/** Pull request description: what broke, what changed, the test that proves it, and the evidence behind the advisory. */
export function renderPrBody({ advisory, callSite, result, affectedInRepo, shapeSource }: PrBodyInput): string {
  const source = result.changes.filter((c) => c.file !== result.test?.file);
  const notes = source.flatMap((c) => c.notes.map((n) => `- ${n}`));
  const method = result.method === "recipe" ? `deterministic recipe \`${advisory.recipeId}\`` : "Claude, verified by the contract test";
  const evidence = advisory.evidence;
  const lines = [
    `**${advisory.provider}** changed \`${advisory.endpoint.method} ${advisory.endpoint.path}\`: ${advisory.title}.`,
    "",
    advisory.summary,
    "",
    "### Affected call site",
    `\`${callSite.file}:${callSite.line}\` (${callSite.method} ${callSite.endpoint})`,
    "",
    `### Change (${method})`,
    ...(notes.length ? notes : source.map((c) => `- \`${c.file}\``)),
    "",
    "### Contract test",
    `Added \`${result.test?.file}\`. It calls the code with the response it was written for and the response ${advisory.provider} sends now.`,
    "",
    "| Run | Result |",
    "|---|---|",
    `| Before this change | ${summary(result.baseline)} |`,
    `| After this change | ${summary(result.attempts.find((a) => a.outcome === "passed")?.run)} |`,
    "",
    "### Evidence",
    "| | |",
    "|---|---|",
    `| Advisory | \`${advisory.id}\` (${advisory.status}) |`,
    `| Severity | ${advisory.severity} |`,
    `| Change class | ${advisory.changeClass} |`,
    `| First observed | ${advisory.firstObserved ?? "unknown"} |`,
    `| Provider notice | ${advisory.publishedNotice ? `[${advisory.publishedNotice.date ?? "link"}](${advisory.publishedNotice.url})` : "none (undocumented change)"} |`,
    `| Shapes from | ${shapeSource} |`,
    ...(evidence ? [`| Observed | ${evidence.before.status} at ${evidence.before.observedAt} → ${evidence.after.status} at ${evidence.after.observedAt} (${evidence.source}) |`] : []),
    `| Blast radius | ${affectedInRepo} affected call site${affectedInRepo === 1 ? "" : "s"} in this repo |`,
    `| Sources | ${advisory.sources.map((s, i) => `[${i + 1}](${s})`).join(" ")} |`,
    "",
    `Migration note: ${advisory.migrationNote}`,
    "",
    "---",
    "Opened by [SHAPI](https://github.com/SriVarshini09/YC). The change was kept only because the contract test failed before it and passes after it.",
  ];
  return lines.join("\n") + "\n";
}

function summary(run: TestRun | undefined): string {
  if (!run) return "not run";
  const m = /Tests\s+([^\n]+?)\s*\(\d+\)/.exec(run.output);
  return `${run.passed ? "pass" : "fail"}${m ? ` (${m[1]!.trim()})` : ""}`;
}
