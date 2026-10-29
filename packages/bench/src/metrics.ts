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
  /** Fix rate is measured once fixes run in the sandbox (P-02 follow-up); null until then. */
  fixRate: null;
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
    fixRate: null,
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
