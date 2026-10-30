import type { MatchResult } from "@shapi/core";
import { SCANNED_EXTENSIONS, type Instance } from "./instances";

/** What SHAPI reported for one advisory in one scan, strongest first. */
export type Verdict = "affected" | "possible" | "exposed" | "none";

export function verdictFor(match: Pick<MatchResult, "affected" | "possible" | "exposed">, advisoryId: string): Verdict {
  if (match.affected.some((f) => f.advisory.id === advisoryId)) return "affected";
  if (match.possible.some((f) => f.advisory.id === advisoryId)) return "possible";
  if (match.exposed.some((f) => f.advisory.id === advisoryId)) return "exposed";
  return "none";
}

/** A rate with its 95% Wilson score interval; null when nothing was measured. */
export interface Rate {
  k: number;
  n: number;
  rate: number;
  low: number;
  high: number;
}

export function wilson(k: number, n: number, z = 1.96): Rate | null {
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { k, n, rate: round(p), low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

/**
 * SHAPI's own fix of an instance flagged `affected` at its base commit, made and checked in the sandbox:
 * - `fixed`: every affected call site was fixed, each with a contract test that failed before and passes after;
 * - `partial`: some call sites were fixed, not all;
 * - `not-fixed`: none was;
 * - `error`: the sandbox or the repository's install failed, so nothing was tried (not counted in the fix rate).
 */
export type FixOutcome = "fixed" | "partial" | "not-fixed" | "error";

/** One instance's outcome. `error` is set when the code could not be fetched or scanned. */
export interface InstanceResult {
  id: string;
  incident: string;
  advisoryId: string | null;
  inScope: boolean;
  language: string | null;
  /** The file the human fix changed (the evidence line), to tell file types SHAPI scans from the rest. */
  evidenceFile: string | null;
  base?: Verdict;
  fix?: Verdict;
  error?: string;
  /** Set when fixes ran (`bench:run -- --fix`) and the base commit was flagged `affected`. */
  fixOutcome?: FixOutcome;
  /** What each call site's repair did, or why the fix could not be tried. */
  fixDetail?: string;
}


export interface Summary {
  instances: number;
  inScope: number;
  scored: number;
  errors: number;
  /** In-scope instances whose base commit SHAPI reported `affected`. */
  flagRecall: Rate | null;
  /** The same, counting `possible` as caught. */
  flagRecallWithPossible: Rate | null;
  /** In-scope instances whose fix commit is no longer `affected`: a flag that survives the human fix is a false positive. */
  fixedStatePrecision: Rate | null;
  /** Flag recall where the broken code is in a file type SHAPI scans (TypeScript, JavaScript, Python). */
  flagRecallScannedFiles: Rate | null;
  byIncident: Record<string, { flagRecall: Rate | null; fixedStatePrecision: Rate | null }>;
  /**
   * Of the instances flagged `affected` whose fix was tried in the sandbox, how many SHAPI fixed completely.
   * Null when fixes did not run. Sandbox and install failures are left out and counted in `fixErrors`.
   */
  fixRate: Rate | null;
  fixErrors: number;
}

export function summarize(results: InstanceResult[]): Summary {
  const scored = results.filter((r) => r.inScope && !r.error && r.base && r.fix);
  const count = (rs: InstanceResult[], pred: (r: InstanceResult) => boolean) => rs.filter(pred).length;
  const recall = (rs: InstanceResult[]) => wilson(count(rs, (r) => r.base === "affected"), rs.length);
  const precision = (rs: InstanceResult[]) => wilson(count(rs, (r) => r.fix !== "affected"), rs.length);
  const incidents = [...new Set(scored.map((r) => r.incident))].sort();
  return {
    instances: results.length,
    inScope: count(results, (r) => r.inScope),
    scored: scored.length,
    errors: count(results, (r) => r.inScope && Boolean(r.error)),
    flagRecall: recall(scored),
    flagRecallWithPossible: wilson(count(scored, (r) => r.base === "affected" || r.base === "possible"), scored.length),
    fixedStatePrecision: precision(scored),
    flagRecallScannedFiles: recall(scored.filter((r) => r.evidenceFile !== null && SCANNED_EXTENSIONS.test(r.evidenceFile))),
    byIncident: Object.fromEntries(
      incidents.map((i) => {
        const rs = scored.filter((r) => r.incident === i);
        return [i, { flagRecall: recall(rs), fixedStatePrecision: precision(rs) }];
      }),
    ),
    fixRate: wilson(count(scored, (r) => r.fixOutcome === "fixed"), count(scored, (r) => r.fixOutcome !== undefined && r.fixOutcome !== "error")),
    fixErrors: count(scored, (r) => r.fixOutcome === "error"),
  };
}

/** The result row for an instance that was not scanned (out of scope), so it still appears in the report. */
export function unscanned(instance: Instance): InstanceResult {
  return {
    id: instance.id,
    incident: instance.incident,
    advisoryId: instance.advisoryId,
    inScope: instance.inScope,
    language: instance.language ?? null,
    evidenceFile: instance.evidence?.file ?? null,
  };
}
