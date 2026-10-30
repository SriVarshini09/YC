/**
 * Record the Wayback Machine's earliest capture of every advisory source (execution plan P-13) in
 * advisories/evidence/captures.json. A capture once found never changes, so it is kept; sources with no capture, or
 * whose lookup failed, are looked up again. Read only: the public CDX API, one request every 1.5 s.
 *
 *   pnpm --filter @shapi/bench bench:wayback
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdvisories } from "@shapi/core";
import { firstCapture, type Capture } from "@shapi/bench";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const out = path.join(repoRoot, "advisories", "evidence", "captures.json");
type Entry = { status: string; sources: Capture[] };
const previous = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { advisories: Record<string, Entry> }).advisories : {};
const known = new Map(Object.values(previous).flatMap((e) => e.sources.filter((s) => s.firstCaptured).map((s) => [s.url, s] as const)));

const advisories: Record<string, Entry> = {};
let lookups = 0;
for (const a of loadAdvisories(path.join(repoRoot, "advisories"))) {
  const sources: Capture[] = [];
  for (const url of a.sources) {
    const kept = known.get(url);
    if (kept) {
      sources.push(kept);
      continue;
    }
    if (lookups++) await new Promise((r) => setTimeout(r, 1500));
    const capture = await firstCapture(url);
    known.set(url, capture);
    sources.push(capture);
    console.log(`${capture.firstCaptured ?? "none"}  ${url}${capture.note ? `  (${capture.note})` : ""}`);
  }
  advisories[a.id] = { status: a.status, sources };
}

const verified = Object.values(advisories).filter((e) => e.status === "verified");
const withCapture = verified.filter((e) => e.sources.some((s) => s.firstCaptured)).length;
const accounted = verified.filter((e) => e.sources.every((s) => s.firstCaptured || s.note)).length;
const summary = {
  verifiedAdvisories: verified.length,
  withACapture: withCapture,
  /** Every source has a capture or a note saying why not: the P-13 target is 90%. */
  everySourceAccountedFor: accounted,
  sources: Object.values(advisories).reduce((n, e) => n + e.sources.length, 0),
  sourcesCaptured: Object.values(advisories).reduce((n, e) => n + e.sources.filter((s) => s.firstCaptured).length, 0),
};
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(
    {
      about: "The Wayback Machine's earliest capture (HTTP 200) of each advisory source. Matching the capture to the advisory's quote waits for provenance quotes (C-02).",
      generatedAt: new Date().toISOString(),
      summary,
      advisories,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(summary, null, 2));
