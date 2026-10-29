import type { Advisory } from "@shapi/core";
import type { AdvisoryRepair, TestRun } from "@shapi/repair";

export interface PrBodyInput {
  advisory: Advisory;
  /** Every affected call site of the advisory and what happened to it. */
  repair: AdvisoryRepair;
  /** Where the before/after shapes came from, for example "canary:github:token" or a recording file. */
  shapeSource: string;
}

export function prTitle(advisory: Advisory): string {
  return `SHAPI: ${advisory.title}`;
}

export function prBranch(advisory: Advisory): string {
  return `shapi/${advisory.id}`;
}

/** Pull request description: what broke, every call site it hits, what changed, the tests that prove it, and the evidence. */
export function renderPrBody({ advisory, repair, shapeSource }: PrBodyInput): string {
  const fixed = repair.sites.filter((s) => s.result.status === "fixed");
  const tests = new Set(fixed.map((s) => s.result.test?.file));
  const notes = repair.changes.filter((c) => !tests.has(c.file)).flatMap((c) => (c.notes.length ? c.notes : [`\`${c.file}\``]).map((n) => `- ${n}`));
  const method = repair.method === "llm" ? "Claude, verified by the contract tests" : `deterministic recipe \`${advisory.recipeId}\``;
  const evidence = advisory.evidence;
  const where = (s: (typeof repair.sites)[number]) => `\`${s.callSite.file}:${s.callSite.line}\` (${s.callSite.method} ${s.callSite.endpoint})`;
  const siteLine = (s: (typeof repair.sites)[number]) =>
    s.result.status === "fixed"
      ? `- [x] ${where(s)}: fixed, test \`${s.result.test?.file}\``
      : s.result.status === "already-handled"
        ? `- [x] ${where(s)}: already handles the change`
        : `- [ ] ${where(s)}: not fixed here (${s.result.reason ?? s.result.status}); needs a manual change`;
  const lines = [
    `**${advisory.provider}** changed \`${advisory.endpoint.method} ${advisory.endpoint.path}\`: ${advisory.title}.`,
    "",
    advisory.summary,
    "",
    `### Affected call sites (${fixed.length} of ${repair.sites.length} fixed here)`,
    ...repair.sites.map(siteLine),
    "",
    `### Change (${method})`,
    ...notes,
    "",
    `### Contract test${fixed.length === 1 ? "" : "s"}`,
    "Each test calls the code with the response it was written for and the one the provider sends now. Each failed before this change and passes after it.",
    "",
    "| Test | Before this change | After this change |",
    "|---|---|---|",
    ...fixed.map((s) => `| \`${s.result.test?.file}\` | ${cell(summary(s.result.baseline))} | ${cell(summary(s.result.attempts.find((a) => a.outcome === "passed")?.run))} |`),
    "",
    "### Evidence",
    "| | |",
    "|---|---|",
    `| Advisory | \`${advisory.id}\` (${advisory.status}) |`,
    `| Severity | ${advisory.severity} |`,
    `| Change class | ${advisory.changeClass} |`,
    `| First observed | ${advisory.firstObserved ?? "unknown"} |`,
    `| Provider notice | ${advisory.publishedNotice ? `[${advisory.publishedNotice.date ?? "link"}](${advisory.publishedNotice.url})` : "none (undocumented change)"} |`,
    `| Shapes from | ${cell(shapeSource)} |`,
    ...(evidence ? [`| Observed | ${evidence.before.status} at ${evidence.before.observedAt} → ${evidence.after.status} at ${evidence.after.observedAt} (${evidence.source}) |`] : []),
    `| Blast radius | ${repair.sites.length} affected call site${repair.sites.length === 1 ? "" : "s"} in this repo |`,
    `| Sources | ${advisory.sources.map((s, i) => `[${i + 1}](${s})`).join(" ")} |`,
    "",
    `Migration note: ${advisory.migrationNote}`,
    "",
    "---",
    "Opened by [SHAPI](https://shapi.dev). A change is kept only when its contract test failed before it and passes after it.",
  ];
  return lines.join("\n") + "\n";
}

/** Text for a Markdown table cell: a "|" (vitest prints "1 failed | 1 passed") would start a new column. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function summary(run: TestRun | undefined): string {
  if (!run) return "not run";
  const m = /Tests\s+([^\n]+?)\s*\(\d+\)/.exec(run.output);
  return `${run.passed ? "pass" : "fail"}${m ? ` (${m[1]!.trim()})` : ""}`;
}
