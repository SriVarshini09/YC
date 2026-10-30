import type { Finding, MatchResult } from "@shapi/core";
import { SCANNED_EXTENSIONS } from "./instances";

/**
 * One public pull request Okapi (GitHub App okapi-agent) opened, as recorded in datasets/okapi-prs.json
 * (execution plan P-04). The `okapi*` fields describe Okapi's PR; `shapi*` fields are hand-checked against
 * SHAPI's advisories when the dataset was built.
 */
export interface OkapiPr {
  repo: string;
  number: number;
  url: string;
  title: string;
  merged: boolean;
  /** The commit Okapi's PR is based on: SHAPI scans the repository there. */
  base: string;
  provider: string;
  /** What kind of change Okapi's PR is about: a model, API version or endpoint retired; a parameter rejected; a response read in the wrong shape; or another bug in the call. */
  kind: "retirement" | "parameter" | "response" | "bug";
  /** The files Okapi changed, with the base-commit line numbers it removed or replaced. */
  files: { path: string; removedLines: number[] }[];
  /** What Okapi's PR moves the code to, when it names one (a model id, an API version). */
  okapiTarget: string | null;
  /** SHAPI's advisories about the same change. Empty when SHAPI has none. */
  shapiAdvisories: string[];
  /** What SHAPI's advisory moves the code to: its fix, or the model or version its migration note names. */
  shapiTarget: string | null;
}

/**
 * SHAPI's result for the change Okapi's PR is about: its strongest finding for SHAPI's advisories on that change,
 * "missed" when it has one and found nothing, "no advisory" when it has none, and "not scanned" when every file
 * Okapi changed is in a language SHAPI does not scan.
 */
export type OkapiVerdict = "affected" | "possible" | "exposed" | "missed" | "no advisory" | "not scanned";

export interface OkapiRow {
  pr: string;
  url: string;
  base: string;
  kind: OkapiPr["kind"];
  provider: string;
  /** SHAPI has an advisory about the change Okapi's PR makes. */
  advisoryPresent: boolean;
  verdict: OkapiVerdict;
  /** Where SHAPI found the change: `file:line advisory`, findings in Okapi's files first. */
  findings: string[];
  /** SHAPI's finding is in a file Okapi changed. */
  sameFile: boolean;
  /** Affected findings for other advisories in the files Okapi changed: what Okapi's PR did not mention. */
  otherFindings: string[];
  fixAgreement: "same target" | "different target" | "no SHAPI target" | "no SHAPI advisory";
  error?: string;
}

/** Base-commit line numbers a unified diff removes or replaces. */
export function removedLines(patch: string): number[] {
  const lines: number[] = [];
  let old = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("-")) lines.push(old++);
    else if (line.startsWith(" ")) old++;
    // "+" lines are new: they do not move the base-commit line counter.
  }
  return lines;
}

const STRENGTH = ["affected", "possible", "exposed"] as const;
const where = (f: Finding) => `${f.callSite.file}:${f.callSite.line} ${f.advisory.id}`;
const unique = (list: string[]) => list.filter((v, i) => list.indexOf(v) === i);

/** Compare one scan with Okapi's PR. `match` is SHAPI's scan of the base commit; undefined when it failed (`error`). */
export function okapiRow(pr: OkapiPr, match: Pick<MatchResult, "affected" | "possible" | "exposed"> | undefined, error?: string): OkapiRow {
  const changed = new Set(pr.files.map((f) => f.path));
  const advisoryPresent = pr.shapiAdvisories.length > 0;
  const ours = (f: Finding) => pr.shapiAdvisories.includes(f.advisory.id);
  const strongest = match ? STRENGTH.find((s) => match[s].some(ours)) : undefined;
  const found = strongest && match ? match[strongest].filter(ours).sort((a, b) => Number(changed.has(b.callSite.file)) - Number(changed.has(a.callSite.file))) : [];
  const verdict: OkapiVerdict = !pr.files.some((f) => SCANNED_EXTENSIONS.test(f.path)) ? "not scanned" : !advisoryPresent ? "no advisory" : (strongest ?? "missed");
  const others = match ? match.affected.filter((f) => !ours(f) && changed.has(f.callSite.file)) : [];
  const fixAgreement: OkapiRow["fixAgreement"] = !advisoryPresent
    ? "no SHAPI advisory"
    : !pr.shapiTarget
      ? "no SHAPI target"
      : pr.shapiTarget === pr.okapiTarget
        ? "same target"
        : "different target";
  return {
    pr: `${pr.repo}#${pr.number}`,
    url: pr.url,
    base: pr.base,
    kind: pr.kind,
    provider: pr.provider,
    advisoryPresent,
    verdict,
    findings: unique(found.map(where)),
    sameFile: found.some((f) => changed.has(f.callSite.file)),
    otherFindings: unique(others.map(where)),
    fixAgreement,
    ...(error ? { error } : {}),
  };
}

const code = (list: string[]) => list.map((f) => "`" + f + "`").join(", ");

/** The head-to-head as a Markdown table, one row per Okapi PR. */
export function okapiTable(prs: OkapiPr[], rows: OkapiRow[]): string {
  const byPr = new Map(prs.map((p) => [`${p.repo}#${p.number}`, p]));
  const head = [
    "| Okapi PR | Change | Base commit | SHAPI advisory | SHAPI verdict | Fix agreement | Other SHAPI findings in Okapi's files |",
    "|---|---|---|---|---|---|---|",
  ];
  const body = rows.map((r) => {
    const pr = byPr.get(r.pr)!;
    const advisory = r.advisoryPresent ? `yes: ${code(pr.shapiAdvisories)}` : "no";
    const verdict = r.error ? `error: ${r.error}` : r.findings.length ? `${r.verdict}${r.sameFile ? "" : " (in another file)"}: ${code(r.findings)}` : r.verdict;
    const fix =
      r.fixAgreement === "same target" || r.fixAgreement === "different target" ? `${r.fixAgreement} (SHAPI ${pr.shapiTarget}, Okapi ${pr.okapiTarget ?? "none"})` : r.fixAgreement;
    const commit = `[${"`" + r.base.slice(0, 7) + "`"}](https://github.com/${pr.repo}/tree/${r.base})`;
    const others = r.otherFindings.length ? code(r.otherFindings) : "none";
    return `| [${r.pr}](${r.url}) | ${pr.kind}: ${pr.title.replace(/\|/g, "\\|")} | ${commit} | ${advisory} | ${verdict} | ${fix} | ${others} |`;
  });
  return [...head, ...body].join("\n");
}
