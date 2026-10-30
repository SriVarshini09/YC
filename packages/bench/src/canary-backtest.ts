/**
 * Canary back-test (execution plan P-11, §3.3): replay each historical incident through the canary's own shape store,
 * diff and draft classifier, at the canary's cycle, and report the classification and how many cycles it took to see.
 * The canary post-dates these incidents, so every case is a reconstruction (datasets/canary-backtest.json).
 */
import { draftAdvisory, replay, type Recording } from "@shapi/canary";
import { ShapeStore } from "@shapi/shapes";

export interface BacktestResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface BacktestCase {
  id: string;
  title: string;
  provider: string;
  method: Recording["method"];
  endpoint: string;
  changedAt: string;
  sources: string[];
  /** From SHAPI's reviewed advisory for the case (`advisory`), when there is one. */
  expected: { changeClass: string; severity: string; advisory?: string };
  /** The canary probe that covers the endpoint today; null when none does. */
  probe: { id: string } | null;
  /** Why the current probe set can't see the change, and what would. */
  gap?: string;
  before: BacktestResponse;
  after: BacktestResponse;
  /** What a probe like today's receives on both sides of the change, when it misses it (`after`: QuickBooks, `before`: Slack). */
  probeSees?: "before" | "after";
}

export interface BacktestResult {
  id: string;
  title: string;
  expected: BacktestCase["expected"];
  /** What the diff and the draft classifier produced from the before and after responses. */
  classified: { changeClass: string | null; severity: string | null; breaking: boolean; changes: string[] };
  classMatches: boolean;
  severityMatches: boolean;
  probe: string | null;
  /** Cycles from the change to the first probe that sees it, with today's probes; null when they never do. */
  cyclesNow: number | null;
  /** The same with the probe the case needs (a burst probe, an old-minorversion probe, a new provider's probe). */
  cyclesWithProbe: number | null;
  gap?: string;
}

const CYCLES = 3;

/** Run responses through the canary's replay at one per cycle around the change; the cycles until the shape changes. */
function cyclesToDetect(c: BacktestCase, cycleMinutes: number, seen: { before: BacktestResponse; after: BacktestResponse }): number | null {
  const at = (n: number) => new Date(Date.parse(c.changedAt) + n * cycleMinutes * 60_000).toISOString();
  const observations = [
    ...Array.from({ length: CYCLES }, (_, i) => ({ observedAt: at(i - CYCLES), ...seen.before })),
    ...Array.from({ length: CYCLES }, (_, i) => ({ observedAt: at(i + 1), ...seen.after })),
  ];
  const memory = ShapeStore.open(":memory:");
  try {
    const { observations: stored } = replay({ provider: c.provider, method: c.method, endpoint: c.endpoint, sources: [], expiresIn: "90d", observations }, memory, "backtest");
    const baseline = stored[CYCLES - 1]!.shapeHash;
    const first = stored.slice(CYCLES).findIndex((o) => o.shapeHash !== baseline);
    return first < 0 ? null : first + 1;
  } finally {
    memory.close();
  }
}

export function runBacktestCase(c: BacktestCase, cycleMinutes: number): BacktestResult {
  const memory = ShapeStore.open(":memory:");
  let classified: BacktestResult["classified"];
  try {
    const { before, after, diff } = replay(
      {
        provider: c.provider,
        method: c.method,
        endpoint: c.endpoint,
        sources: c.sources,
        expiresIn: "90d",
        observations: [
          { observedAt: new Date(Date.parse(c.changedAt) - cycleMinutes * 60_000).toISOString(), ...c.before },
          { observedAt: new Date(Date.parse(c.changedAt) + cycleMinutes * 60_000).toISOString(), ...c.after },
        ],
      },
      memory,
      "backtest",
    );
    const draft = before && diff ? draftAdvisory({ before, after, diff }) : undefined;
    classified = { changeClass: draft?.changeClass ?? null, severity: draft?.severity ?? null, breaking: diff?.breaking ?? false, changes: (diff?.changes ?? []).map((ch) => `${ch.impact}: ${ch.detail}`) };
  } finally {
    memory.close();
  }
  const real = { before: c.before, after: c.after };
  const today = c.probeSees ? { before: c[c.probeSees], after: c[c.probeSees] } : real;
  return {
    id: c.id,
    title: c.title,
    expected: c.expected,
    classified,
    classMatches: classified.changeClass === c.expected.changeClass,
    severityMatches: classified.severity === c.expected.severity,
    probe: c.probe?.id ?? null,
    cyclesNow: c.probe ? cyclesToDetect(c, cycleMinutes, today) : null,
    cyclesWithProbe: cyclesToDetect(c, cycleMinutes, real),
    ...(c.gap ? { gap: c.gap } : {}),
  };
}
