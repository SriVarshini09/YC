/**
 * APIBreak-Replay instances: a public repository that fixed a third-party API change by hand. SHAPI is
 * scanned at the commit before the fix (where it should flag the call site) and at the fix (where the
 * flag should be gone).
 */
export interface Instance {
  /** `<incident>__<owner>__<repo>`. */
  id: string;
  incident: string;
  /** Hand label from the commit-mining review. */
  class: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** The human fix. */
  fixCommit: string;
  /** The fix's first parent: the code before the fix. Filled by the build script. */
  baseCommit?: string;
  /** Date of the fix commit, YYYY-MM-DD. */
  fixDate: string;
  /** Days between the provider's change and the fix. */
  lagDays: number;
  fixUrl: string;
  subject: string;
  /** The SHAPI advisory this instance tests, or null when SHAPI has none for it yet. */
  advisoryId: string | null;
  /** Scored instances: SHAPI should report `affected` at the base commit and not at the fix. */
  inScope: boolean;
  /** Why an instance is not scored, kept so it is reported rather than dropped. */
  outOfScopeReason?: string;
  /** GitHub's primary language for the repository. */
  language?: string | null;
  /** SPDX id of the repository's license, or null when it has none GitHub recognizes. */
  license?: string | null;
  /** The line the human fix removed that shows the code depended on the old behavior. */
  evidence?: { file: string; removed: string };
}

/**
 * What a removed line must contain to show that the code before the fix was affected. Without such a
 * line the fix may have added something new (a minor version where there was none), so the instance
 * is not scored.
 */
export const TRIGGER_EVIDENCE: Record<string, RegExp> = {
  "github-workflow-dispatch-204-to-200": /\b204\b/,
  "quickbooks-minorversion-below-75-ignored": /minor_?version["'\s]*[:=,]?\s*["'`]?(?:[0-9]|[1-6][0-9]|7[0-4])(?![0-9])/i,
};

/** The first line the fix removed that matches the advisory's trigger, from GitHub's per-file patches. */
export function evidenceIn(files: { filename: string; patch?: string }[], advisoryId: string): { file: string; removed: string } | undefined {
  const trigger = TRIGGER_EVIDENCE[advisoryId];
  if (!trigger) return undefined;
  for (const f of files) {
    for (const line of (f.patch ?? "").split("\n")) {
      if (line.startsWith("-") && !line.startsWith("---") && trigger.test(line)) return { file: f.filename, removed: line.slice(1).trim().slice(0, 200) };
    }
  }
  return undefined;
}

/** Source files SHAPI scans, by extension. */
export const SCANNED_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py)$/i;

export interface Dataset {
  name: string;
  version: string;
  description: string;
  source: string;
  instances: Instance[];
}

interface ClassRule {
  advisoryId: string | null;
  inScope: boolean;
  reason?: string;
}

/** What each hand label means for scoring. */
export const CLASS_RULES: Record<string, ClassRule> = {
  "github-workflow-dispatch-204-to-200/accept-200": { advisoryId: "github-workflow-dispatch-204-to-200", inScope: true },
  "github-workflow-dispatch-204-to-200/empty-204": {
    advisoryId: null,
    inScope: false,
    reason: "broke on the empty 204 after GitHub made the 200 opt-in (2026-02-19); SHAPI has no advisory for that change yet",
  },
  "github-workflow-dispatch-204-to-200/run-details": { advisoryId: null, inScope: false, reason: "adopted the new run id: a feature, not a breakage" },
  "quickbooks-minorversion-below-75/moved-to-75": { advisoryId: "quickbooks-minorversion-below-75-ignored", inScope: true },
  "quickbooks-minorversion-below-75/pinned-old": {
    advisoryId: "quickbooks-minorversion-below-75-ignored",
    inScope: false,
    reason: "the commit pins an ignored minor version, so the problem starts at the fix commit; scored separately",
  },
};

/** One row of `commit-mining-verified.csv`. */
export interface VerifiedRow {
  incident: string;
  class: string;
  repo: string;
  date: string;
  lag_days: string;
  url: string;
  subject: string;
}

/** An instance for each verified row, without the fields the build script looks up on GitHub. */
export function instanceFromRow(row: VerifiedRow): Instance {
  const rule = CLASS_RULES[`${row.incident}/${row.class}`];
  if (!rule) throw new Error(`no scoring rule for ${row.incident}/${row.class}`);
  const sha = /\/commit\/([0-9a-f]{40})$/.exec(row.url)?.[1];
  if (!sha) throw new Error(`not a commit URL: ${row.url}`);
  const [owner, name] = row.repo.split("/");
  return {
    id: `${row.incident}__${owner}__${name}`,
    incident: row.incident,
    class: row.class,
    repo: row.repo,
    fixCommit: sha,
    fixDate: row.date,
    lagDays: Number(row.lag_days),
    fixUrl: row.url,
    subject: row.subject,
    advisoryId: rule.advisoryId,
    inScope: rule.inScope,
    ...(rule.reason ? { outOfScopeReason: rule.reason } : {}),
  };
}

/** Parse a CSV whose fields are double-quoted (as `commit-mining-verified.csv` is). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
