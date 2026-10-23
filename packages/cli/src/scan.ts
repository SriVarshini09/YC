import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SEVERITIES,
  SEVERITY_RANK,
  createApiLock,
  loadAdvisories,
  matchAdvisories,
  writeApiLock,
  type ApiLock,
  type Finding,
  type MatchResult,
  type Severity,
} from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { bundledDir } from "./paths";

export const VERSION = "0.1.0";

/** Advisories shipped with SHAPI (the published package's advisories/, or the repository root's in the monorepo). */
export const DEFAULT_ADVISORIES = bundledDir("advisories", "advisories");

export interface ScanOptions {
  json?: boolean;
  out?: string;
  repo?: string;
  advisories?: string;
  failOn?: string;
  now?: string;
  color?: boolean;
}

export interface ScanOutcome {
  label: string;
  filesScanned: number;
  lock: ApiLock;
  match: MatchResult;
  elapsedMs: number;
  exitCode: number;
}

export function scan(target: string | undefined, opts: ScanOptions): ScanOutcome {
  const started = performance.now();
  const failOn = parseFailOn(opts.failOn ?? "critical");
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${opts.now}`);

  let dir = path.resolve(target ?? ".");
  let label = target ?? ".";
  let cleanup: string | undefined;
  if (opts.repo) {
    if (opts.repo.startsWith("-")) throw new Error(`--repo: not a repository URL: ${opts.repo}`);
    cleanup = mkdtempSync(path.join(os.tmpdir(), "shapi-scan-"));
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--quiet", "--", opts.repo, cleanup], { stdio: ["ignore", "ignore", "pipe"] });
    dir = cleanup;
    label = opts.repo;
  }

  try {
    const extracted = extractCallSites(dir);
    const lock = createApiLock(extracted, `shapi ${VERSION}`);
    if (opts.out) writeApiLock(opts.out, lock);
    const advisories = loadAdvisories(opts.advisories ?? DEFAULT_ADVISORIES);
    const match = matchAdvisories(lock, advisories, { now });
    const failing = failOn === "none" ? [] : match.affected.filter((f) => SEVERITY_RANK[f.advisory.severity] <= SEVERITY_RANK[failOn]);
    return {
      label,
      filesScanned: extracted.filesScanned,
      lock,
      match,
      elapsedMs: Math.round(performance.now() - started),
      exitCode: failing.length > 0 ? 1 : 0,
    };
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

function parseFailOn(value: string): Severity | "none" {
  if (value === "none" || (SEVERITIES as readonly string[]).includes(value)) return value as Severity | "none";
  throw new Error(`--fail-on: expected one of ${[...SEVERITIES, "none"].join(", ")}, got ${value}`);
}

/** Machine-readable report: the api.lock plus findings that point back into it by call-site id. */
export function toJsonReport(o: ScanOutcome): unknown {
  const finding = (f: Finding) => ({
    advisory: f.advisory.id,
    severity: f.advisory.severity,
    title: f.advisory.title,
    callSite: f.callSite.id,
    file: f.callSite.file,
    line: f.callSite.line,
    method: f.callSite.method,
    endpoint: f.callSite.endpoint,
    reasons: f.reasons,
    migrationNote: f.advisory.migrationNote,
  });
  return {
    target: o.label,
    filesScanned: o.filesScanned,
    affected: o.match.affected.map(finding),
    exposed: o.match.exposed.map(finding),
    upcoming: o.match.upcoming.map((u) => ({
      advisory: u.advisory.id,
      provider: u.advisory.provider,
      title: u.advisory.title,
      effectiveDate: u.advisory.effectiveDate,
      daysUntil: u.daysUntil,
      callSites: u.callSites,
    })),
    lock: o.lock,
  };
}
