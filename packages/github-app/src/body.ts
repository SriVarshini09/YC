import type { Advisory } from "@shapi/core";
import { codeSpan, testCounts, type AdvisoryRepair, type TestRun, type TypeCheck } from "@shapi/repair";

export { codeSpan };

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
  // Claude's explanations are model output (the model read the repository's code): shown as literal text.
  const explanations = new Set(repair.sites.filter((s) => s.result.method === "llm").flatMap((s) => s.result.changes.flatMap((c) => c.notes)));
  const note = (n: string) => (explanations.has(n) ? `Claude: ${codeSpan(n)}` : n);
  // Recipe notes put the repository's code and paths in code spans already (see Edit.note).
  const notes = repair.changes.filter((c) => !tests.has(c.file)).flatMap((c) => (c.notes.length ? c.notes.map(note) : [codeSpan(c.file)]).map((n) => `- ${n}`));
  const method = repair.method === "llm" ? "Claude, verified by the contract tests" : `deterministic recipe \`${advisory.recipeId}\``;
  const evidence = advisory.evidence;
  const where = (s: (typeof repair.sites)[number]) => `${codeSpan(`${s.callSite.file}:${s.callSite.line}`)} (${codeSpan(`${s.callSite.method} ${s.callSite.endpoint}`)})`;
  const siteLine = (s: (typeof repair.sites)[number]) =>
    s.result.status === "fixed"
      ? `- [x] ${where(s)}: fixed, test \`${s.result.test?.file}\``
      : s.result.status === "already-handled"
        ? `- [x] ${where(s)}: already handles the change`
        : // The reason can quote the test run's output, which the repository's code prints.
          `- [ ] ${where(s)}: not fixed here (${codeSpan(s.result.reason ?? s.result.status, 300)}); needs a manual change`;
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
    "Each test calls the code with the response it was written for and the one the provider sends now. Each failed before this change and passes after it. A change that adds type errors is not kept.",
    "",
    "| Test | Before this change | After this change | Type check |",
    "|---|---|---|---|",
    ...fixed.map(
      (s) =>
        `| \`${s.result.test?.file}\` | ${cell(summary(s.result.baseline))} | ${cell(summary(s.result.attempts.find((a) => a.outcome === "passed")?.run))} | ${cell(typeSummary(s.result.typecheck))} |`,
    ),
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

function typeSummary(check: TypeCheck | undefined): string {
  if (!check) return "not run";
  return `${check.status === "passed" ? "pass" : check.status === "failed" ? "fail" : "skipped"}: ${codeSpan(check.detail, 300)}`;
}

/** The verdict and vitest's counts; nothing else from the output, which the repository's code prints to. */
function summary(run: TestRun | undefined): string {
  if (!run) return "not run";
  const counts = testCounts(run.output);
  return `${run.passed ? "pass" : "fail"}${counts ? ` (${counts})` : ""}`;
}
