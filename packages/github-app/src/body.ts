import { getProvider, type Advisory } from "@shapi/core";
import { changedRanges, codeSpan, testCounts, type AdvisoryRepair, type FileChange, type SuiteCheck, type TestRun, type ScopeCheck, type TypeCheck, type UndoCheck } from "@shapi/repair";

export { codeSpan };

export interface PrBodyInput {
  advisory: Advisory;
  /** Every affected call site of the advisory and what happened to it. */
  repair: AdvisoryRepair;
  /** Where the before/after shapes came from, for example "canary:github:token" or a recording file. */
  shapeSource: string;
  /** The repository's page in the SHAPI web app. */
  dashboardUrl?: string;
  /** The recorded witnesses the contract tests' stub was built from (V-03), when there were any. */
  witnesses?: { before: string; after: string };
  /** Today, for the countdown to the advisory's effective date. */
  now?: Date;
  /** Call sites SHAPI inspected for this advisory and left alone, with why (D-02 counts them against the matcher). */
  notChanged?: { file: string; line: number; method: string | null; endpoint: string | null; reason: string }[];
  /** Signed links for the 👍/👎 feedback buttons (D-01); none without the web app. */
  feedback?: { up: string; down: string };
}

export function prTitle(advisory: Advisory): string {
  return `SHAPI: ${advisory.title}`;
}

export function prBranch(advisory: Advisory): string {
  return `shapi/${advisory.id}`;
}

type Site = AdvisoryRepair["sites"][number];
const DAY_MS = 86_400_000;

/**
 * Pull request description (execution plan D-01): a lead line with the deadline, a Before/After/Where table, size,
 * tier and confidence, the five checks on one line, what could still go wrong, then the provider's words, the checks
 * in detail, the evidence and the call sites left alone in collapsible sections, and 👍/👎 links.
 */
export function renderPrBody(input: PrBodyInput): string {
  const { advisory, repair, shapeSource, dashboardUrl, witnesses } = input;
  const fixed = repair.sites.filter((s) => s.result.status === "fixed");
  const tests = new Set(fixed.map((s) => s.result.test?.file));
  // Claude's explanations are model output (the model read the repository's code): shown as literal text.
  const explanations = new Set(repair.sites.filter((s) => s.result.method === "llm").flatMap((s) => s.result.changes.flatMap((c) => c.notes)));
  const note = (n: string) => (explanations.has(n) ? `Claude: ${codeSpan(n)}` : n);
  // Recipe notes put the repository's code and paths in code spans already (see Edit.note).
  const notes = repair.changes.filter((c) => !tests.has(c.file)).flatMap((c) => (c.notes.length ? c.notes.map(note) : [codeSpan(c.file)]).map((n) => `- ${n}`));
  const method = repair.method === "llm" ? "Claude, verified by the contract tests" : `deterministic recipe \`${advisory.recipeId}\``;
  const evidence = advisory.evidence;
  const source = repair.changes.filter((c) => !tests.has(c.file));
  const notChanged = input.notChanged ?? [];
  // The provider's display name ("GitHub"), not its id ("github").
  const provider = getProvider(advisory.provider)?.name ?? advisory.provider;

  const lines = [
    lead(advisory, provider, input.now ?? new Date()),
    "",
    `In this repository it affects ${plural(repair.sites.length, "call site")}; SHAPI fixed ${fixed.length === repair.sites.length ? (fixed.length === 1 ? "it" : "all of them") : `${fixed.length}`} here. ${advisory.summary}`,
    "",
    "| Call | Before | After | Where |",
    "|---|---|---|---|",
    ...repair.sites.map(row),
    "",
    `\`${sizeOf(source)} · Tier: Review · Confidence: ${confidence(repair, fixed)}\``,
    "",
    checkedLine(repair, fixed),
    "",
    `**Could change:** ${couldChange(repair, fixed)}`,
    ...(outsideValues(advisory) ? ["", "Also check values set outside this repository (environment variables, secrets): SHAPI reads only the code."] : []),
    "",
    details(`What ${provider} announced`, announced(advisory, provider)),
    details(`Affected call sites (${fixed.length} of ${repair.sites.length} fixed here)`, repair.sites.map(siteLine).join("\n")),
    details(
      `Change and checks (${method})`,
      [
        ...notes,
        "",
        "Each contract test calls the code with the response it was written for and the one the provider sends now. Each failed before this change and passes after it. A change that adds type errors is not kept.",
        "",
        stubLine(fixed.map((s) => s.result.test?.kind), shapeSource, witnesses),
        "",
        undoLine(fixed.map((s) => s.result.undo)),
        "",
        scopeLine(fixed.map((s) => s.result.scope)),
        "",
        "| Test | Before this change | After this change | Type check |",
        "|---|---|---|---|",
        ...fixed.map(
          (s) =>
            `| \`${s.result.test?.file}\` | ${cell(summary(s.result.baseline))} | ${cell(summary(s.result.attempts.find((a) => a.outcome === "passed")?.run))} | ${cell(typeSummary(s.result.typecheck))} |`,
        ),
        "",
        suiteLine(repair.suite),
      ].join("\n"),
    ),
    details(
      "Evidence",
      [
        "| | |",
        "|---|---|",
        `| Advisory | \`${advisory.id}\` (${advisory.status}) |`,
        `| Severity | ${advisory.severity} |`,
        `| Change class | ${advisory.changeClass} |`,
        `| First observed | ${advisory.firstObserved ?? "unknown"} |`,
        `| Provider notice | ${advisory.publishedNotice ? `[${advisory.publishedNotice.date ?? "link"}](${advisory.publishedNotice.url})` : "none (undocumented change)"} |`,
        `| Shapes from | ${cell(shapeSource)} |`,
        ...(evidence ? [`| Observed | ${evidence.before.status} at ${evidence.before.observedAt} → ${evidence.after.status} at ${evidence.after.observedAt} (${evidence.source}) |`] : []),
        `| Blast radius | ${plural(repair.sites.length, "affected call site")} in this repo |`,
        `| Sources | ${advisory.sources.map((s, i) => `[${i + 1}](${s})`).join(" ")} |`,
        "",
        `Migration note: ${advisory.migrationNote}`,
      ].join("\n"),
    ),
    details(
      `Not changed (${notChanged.length})`,
      notChanged.length
        ? notChanged.map((n) => `- ${codeSpan(`${n.file}:${n.line}`)} (${codeSpan(`${n.method ?? "?"} ${n.endpoint ?? "?"}`)}): ${codeSpan(n.reason, 300)}`).join("\n")
        : "SHAPI found no other call site of this endpoint in the repository.",
    ),
    ...(input.feedback ? [`Was this pull request useful? [👍 Yes](${input.feedback.up}) · [👎 No](${input.feedback.down})`, ""] : []),
    "---",
    `Opened by [SHAPI](https://shapi.dev). A change is kept only when its contract test failed before it and passes after it.${dashboardUrl ? ` [View this repository in SHAPI](${dashboardUrl}).` : ""}`,
  ];
  return lines.join("\n") + "\n";
}

/** The bold lead line: who changed what, and when it takes (or took) effect. */
function lead(advisory: Advisory, provider: string, now: Date): string {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const days = Math.round((Date.parse(advisory.effectiveDate) - today) / DAY_MS);
  const when = days > 0 ? `takes effect on ${advisory.effectiveDate}, in ${plural(days, "day")}` : days === 0 ? `takes effect today, ${advisory.effectiveDate}` : `took effect on ${advisory.effectiveDate}, ${plural(-days, "day")} ago`;
  return `**${provider}: ${advisory.title}. It ${when}.**`;
}

/** One table row per affected call site: the call, the changed line before and after, and where it is. */
function row(s: Site): string {
  const call = codeSpan(`${s.callSite.method ?? "?"} ${s.callSite.endpoint ?? "?"}`);
  const where = codeSpan(`${s.callSite.file}:${s.callSite.line}`);
  if (s.result.status === "already-handled") return `| ${call} | already handles the change | unchanged | ${where} |`;
  if (s.result.status !== "fixed") return `| ${call} | — | not fixed here (see below) | ${where} |`;
  const change = s.result.changes.find((c) => c.file === s.callSite.file);
  const pair = change ? nearestChange(change, s.callSite.line) : undefined;
  return `| ${call} | ${pair ? codeSpan(pair.before, 120) : "—"} | ${pair ? codeSpan(pair.after, 120) : "—"} | ${where} |`;
}

/** The changed lines nearest the call, first line of each side, trimmed. */
function nearestChange(change: FileChange, line: number): { before: string; after: string } | undefined {
  const hunks = changedRanges(change.before, change.after);
  if (!hunks.length) return undefined;
  const h = [...hunks].sort((x, y) => Math.abs(x.b0 + 1 - line) - Math.abs(y.b0 + 1 - line))[0]!;
  const side = (text: string, from: number, to: number) => {
    const ls = text.split("\n").slice(from, to).map((l) => l.trim()).filter(Boolean);
    return ls.length ? `${ls[0]}${ls.length > 1 ? " …" : ""}` : "(nothing)";
  };
  return { before: side(change.before, h.a0, h.a1), after: side(change.after, h.b0, h.b1) };
}

/** `Size: +3 −1 in 1 file` over the source changes (not the generated tests). */
function sizeOf(changes: FileChange[]): string {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    for (const h of changedRanges(c.before, c.after)) {
      added += h.b1 - h.b0;
      removed += h.a1 - h.a0;
    }
  }
  return `Size: +${added} −${removed} in ${plural(changes.length, "file")}`;
}

/**
 * How much to trust the change, from the checks alone: high for a deterministic recipe that passed every check that
 * ran, including the repository's tests; low when the undo or scope check needs a person; medium otherwise.
 */
function confidence(repair: AdvisoryRepair, fixed: Site[]): "high" | "medium" | "low" {
  if (fixed.some((s) => s.result.undo?.status === "survived" || s.result.scope?.status === "out-of-scope")) return "low";
  const allChecks = fixed.every((s) => s.result.undo?.status === "passed" && s.result.scope?.status === "in-scope");
  return repair.method !== "llm" && allChecks && repair.suite?.status === "passed" ? "high" : "medium";
}

/** The five checks on one line: contract test, your tests, undo, scope, type check; what did not run, and why. */
function checkedLine(repair: AdvisoryRepair, fixed: Site[]): string {
  const done: string[] = [];
  const notRun: string[] = [];
  if (fixed.length) done.push("✅ contract test (failed before, passes after)");
  const suite = repair.suite;
  if (suite?.status === "passed") done.push(`✅ your tests${suite.after ? ` ${suite.after}` : ""}`);
  else notRun.push(`your tests (${suite?.detail ?? "not checked"})`);
  const undo = fixed.map((s) => s.result.undo).filter((u): u is UndoCheck => u !== undefined && u.status !== "not-run");
  if (undo.length) {
    const killed = undo.reduce((n, u) => n + u.killed, 0);
    const total = undo.reduce((n, u) => n + u.total, 0);
    done.push(`${killed === total ? "✅" : "⚠️"} undo check ${killed}/${total}`);
  } else notRun.push(`undo check (${fixed.find((s) => s.result.undo)?.result.undo?.detail ?? "not checked"})`);
  const scope = fixed.map((s) => s.result.scope).filter((c): c is ScopeCheck => c !== undefined);
  if (scope.length) done.push(scope.every((c) => c.status === "in-scope") ? "✅ scope" : "⚠️ scope");
  else notRun.push("scope (not checked)");
  const types = fixed.map((s) => s.result.typecheck).filter((t): t is TypeCheck => t !== undefined);
  if (types.length && types.every((t) => t.status === "passed")) done.push("✅ type check");
  else notRun.push(`type check (${types.find((t) => t.status !== "passed")?.detail.split(":")[0] ?? "not checked"})`);
  return `**Checked:** ${[...done, ...(notRun.length ? [`⚪ not run: ${notRun.join("; ")}`] : [])].join(" · ")}`;
}

/** One sentence of residual risk, the most important first. */
function couldChange(repair: AdvisoryRepair, fixed: Site[]): string {
  const unfixed = repair.sites.length - fixed.length;
  if (unfixed > 0) return `${plural(unfixed, "call site")} still need${unfixed === 1 ? "s" : ""} a change by hand (listed under Affected call sites).`;
  if (fixed.some((s) => s.result.scope?.status === "out-of-scope")) return "the change edits code outside the function that makes the call; read those edits before merging.";
  if (fixed.some((s) => s.result.undo?.status === "survived")) return "part of the change is not covered by its contract test; read that part before merging.";
  if (repair.method === "llm") return "Claude wrote this change; every check above passed, but read the diff as you would a colleague's.";
  return "code that reaches this endpoint in a way SHAPI cannot read (a URL built elsewhere, a value from configuration) is not covered; see Not changed below.";
}

/** Whether the change turns on a value the code may take from outside the repository: a model, a version, a header. */
function outsideValues(advisory: Advisory): boolean {
  const t = advisory.trigger;
  return Boolean(t.body?.some((b) => b.values) || t.query?.length || t.headers?.length);
}

/** The provider's own words. Verbatim quotes arrive with C-02; until then the notice, and a note that the summary is SHAPI's. */
function announced(advisory: Advisory, provider: string): string {
  const notice = advisory.publishedNotice
    ? `${provider}'s notice${advisory.publishedNotice.date ? ` of ${advisory.publishedNotice.date}` : ""}: ${advisory.publishedNotice.url}`
    : `${provider} published no notice: this change was found from its behavior.`;
  return `${notice}\n\nThe summary above is SHAPI's, not ${provider}'s words.`;
}

function details(summary: string, body: string): string {
  return `<details><summary>${summary.replace(/[<>&]/g, "")}</summary>\n\n${body}\n\n</details>\n`;
}

function siteLine(s: Site): string {
  const where = `${codeSpan(`${s.callSite.file}:${s.callSite.line}`)} (${codeSpan(`${s.callSite.method} ${s.callSite.endpoint}`)})`;
  if (s.result.status === "fixed") return `- [x] ${where}: fixed, test \`${s.result.test?.file}\``;
  if (s.result.status === "already-handled") return `- [x] ${where}: already handles the change`;
  // The reason can quote the test run's output, which the repository's code prints.
  return `- [ ] ${where}: not fixed here (${codeSpan(s.result.reason ?? s.result.status, 300)}); needs a manual change`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Text for a Markdown table cell: a "|" (vitest prints "1 failed | 1 passed") would start a new column. */
export function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function typeSummary(check: TypeCheck | undefined): string {
  if (!check) return "not run";
  return `${check.status === "passed" ? "pass" : check.status === "failed" ? "fail" : "skipped"}: ${codeSpan(check.detail, 300)}`;
}

/**
 * The repository's own tests before and after the change. Only the runner's counts and SHAPI's own words
 * appear: the names of failing tests come from output the repository's code prints to, so they stay out.
 */
export function suiteLine(suite: SuiteCheck | undefined): string {
  if (!suite || suite.status === "not-run") return `**Your tests:** ⚪ not run: ${suite?.detail ?? "not checked"}.`;
  const parts = [...(suite.before ? [`before: ${codeSpan(suite.before)}`] : []), ...(suite.after ? [`after: ${codeSpan(suite.after)}`] : [])];
  const counts = parts.length ? ` (${parts.join("; ")})` : "";
  const command = suite.command ? ` ${codeSpan(suite.command)}` : "";
  const flaky = (suite.runs ?? 1) > 1 ? `, after ${suite.runs} runs (a flaky test)` : "";
  return `**Your tests:** ✅${command} passes with this change${flaky}${counts}.`;
}

/**
 * What the contract tests' fake provider answers with (execution plan V-03): responses SHAPI recorded, so the fix
 * and its test do not share one belief, or, when none exist, a stub synthesized from the advisory.
 */
function stubLine(kinds: (string | undefined)[], shapeSource: string, witnesses: PrBodyInput["witnesses"]): string {
  if (kinds.length && kinds.every((k) => k === "recorded")) {
    // Shape ids are hex, so plain code spans are safe.
    const short = (id: string) => `\`${id.replace(/[^0-9a-f]/g, "").slice(0, 12)}\``;
    const ids = witnesses ? `, witnesses ${short(witnesses.before)} → ${short(witnesses.after)}` : "";
    return `**Stub:** from recorded responses (${shapeSource}${ids}).`;
  }
  return "**Stub:** synthesized from the advisory (no recorded responses for this endpoint).";
}

/** The scope check across the fixed call sites (V-05): every edit inside the function that makes the call. */
export function scopeLine(checks: (ScopeCheck | undefined)[]): string {
  const outside = checks.flatMap((c) => (c?.status === "out-of-scope" ? (c.outside ?? []) : []));
  if (outside.length) {
    return `**Scope:** ⚠️ the change also edits ${outside.map((o) => codeSpan(o)).join(", ")}, outside the function that makes the call. This PR is a draft for a person to check (labelled \`needs-human\`).`;
  }
  if (checks.some((c) => c?.status === "in-scope")) return "**Scope:** ✅ every edit is inside the function that makes the call.";
  return "**Scope:** ⚪ not checked.";
}

/** The undo check across the fixed call sites (V-04): undoing each part of the change must make its test fail. */
export function undoLine(checks: (UndoCheck | undefined)[]): string {
  const ran = checks.filter((c): c is UndoCheck => c !== undefined && c.status !== "not-run");
  if (!ran.length) {
    const why = checks.find((c) => c?.status === "not-run")?.detail;
    return `**Undo check:** ⚪ not run${why ? `: ${why}` : ""}.`;
  }
  const killed = ran.reduce((n, c) => n + c.killed, 0);
  const total = ran.reduce((n, c) => n + c.total, 0);
  const survived = ran.flatMap((c) => c.survived ?? []);
  if (!survived.length) return `**Undo check:** ✅ ${killed}/${total}: undoing any part of this change makes its contract test fail.`;
  return `**Undo check:** ⚠️ ${killed}/${total}: undoing ${survived.map((s) => codeSpan(s)).join(", ")} does not make the contract test fail, so the test does not cover that part. A person should check it (labelled \`needs-human\`).`;
}

/** The verdict and vitest's counts; nothing else from the output, which the repository's code prints to. */
function summary(run: TestRun | undefined): string {
  if (!run) return "not run";
  const counts = testCounts(run.output);
  return `${run.passed ? "pass" : "fail"}${counts ? ` (${counts})` : ""}`;
}
