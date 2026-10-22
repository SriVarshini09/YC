import { SEVERITIES, type Advisory } from "@shapi/core";

/** Noise limits per repository, like Renovate's prHourlyLimit and prConcurrentLimit. */
export interface PrLimits {
  /** New fix PRs per rolling hour. */
  hourly: number;
  /** Open SHAPI PRs at once. */
  open: number;
}

export const DEFAULT_PR_LIMITS: PrLimits = { hourly: 2, open: 10 };

/** Label that tells SHAPI to stop updating a pull request. */
export const STOP_LABEL = "shapi:stop";

export type FixPrState = "open" | "closed" | "merged";

export interface ExistingFixPr {
  state: FixPrState;
  /** The stop label is on it, or someone else pushed to its branch. */
  stopped: boolean;
}

export interface PlanInput {
  /** Advisories with a verified fix ready for this repository. */
  candidates: Advisory[];
  /** What SHAPI already opened in this repository, by advisory id. */
  existing: ReadonlyMap<string, ExistingFixPr>;
  /** Open SHAPI PRs now, and how many were opened in the last hour. */
  openCount: number;
  createdLastHour: number;
  limits: PrLimits;
  /** Paused from the dashboard: SHAPI changes nothing in this repository. */
  paused: boolean;
  /** Ticked on the dashboard: open these now, past the limits. */
  createNow: ReadonlySet<string>;
  /** Ticked on the dashboard: reopen fixes a maintainer closed. */
  retry: ReadonlySet<string>;
}

export type PrAction = "create" | "update" | "wait" | "skip";

export interface PrDecision {
  advisory: Advisory;
  action: PrAction;
  /** Why it waits or is skipped, in words for the dashboard. */
  reason?: string;
}

/** Most urgent first: severity, then the earliest effective date. */
export function byUrgency(a: Advisory, b: Advisory): number {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id);
}

/**
 * Decide what to do with each ready fix. Open PRs are kept up to date (they do not use up limits);
 * a PR a maintainer closed without merging is never reopened unless they ask from the dashboard;
 * new PRs open most urgent first until the hourly or open limit is reached, and the rest wait.
 */
export function planFixPrs(input: PlanInput): PrDecision[] {
  let open = input.openCount;
  let created = input.createdLastHour;
  return [...input.candidates].sort(byUrgency).map((advisory): PrDecision => {
    if (input.paused) return { advisory, action: "wait", reason: "paused from the dashboard" };
    const existing = input.existing.get(advisory.id);
    if (existing?.state === "open") {
      return existing.stopped ? { advisory, action: "skip", reason: "updates stopped on this PR" } : { advisory, action: "update" };
    }
    if (existing?.state === "closed" && !input.retry.has(advisory.id)) {
      return { advisory, action: "skip", reason: "closed without merging" };
    }
    const forced = input.createNow.has(advisory.id) || input.retry.has(advisory.id);
    if (!forced && open >= input.limits.open) return { advisory, action: "wait", reason: `open PR limit (${input.limits.open}) reached` };
    if (!forced && created >= input.limits.hourly) return { advisory, action: "wait", reason: `hourly PR limit (${input.limits.hourly}) reached` };
    open++;
    created++;
    return { advisory, action: "create" };
  });
}
