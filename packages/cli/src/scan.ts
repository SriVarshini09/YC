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
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { bundledDir } from "./paths";

export const VERSION = "0.3.0";

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
  /** What to pass to `shapi fix` for the same code: the path, or --repo <url>. */
  fixTarget: string;
  filesScanned: number;
  /** Files that could not be scanned, with why. */
  skipped: { file: string; reason: string }[];
  lock: ApiLock;
  match: MatchResult;
  elapsedMs: number;
  exitCode: number;
}

/**
 * Load the Python grammar so scans include Python files. Call once before scan() or fix(); when it
 * cannot load, TypeScript and JavaScript are still scanned and Python files are listed as skipped.
 */
export async function preparePython(): Promise<void> {
  await loadPythonParser().catch(() => undefined);
}

export function scan(target: string | undefined, opts: ScanOptions): ScanOutcome {
  const started = performance.now();
  const failOn = parseFailOn(opts.failOn ?? "critical");
  const now = opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${opts.now}`);

  const cleanup = opts.repo ? cloneShallow(opts.repo, "shapi-scan-") : undefined;
  const dir = cleanup ?? path.resolve(target ?? ".");
  const label = opts.repo ? redactUrl(opts.repo) : (target ?? ".");

  try {
    const extracted = extractCallSites(dir);
    const lock = createApiLock(extracted, `shapi ${VERSION}`);
    if (opts.out) writeApiLock(opts.out, lock);
    const advisories = loadAdvisories(opts.advisories ?? DEFAULT_ADVISORIES);
    const match = matchAdvisories(lock, advisories, { now });
    const failing = failOn === "none" ? [] : match.affected.filter((f) => SEVERITY_RANK[f.advisory.severity] <= SEVERITY_RANK[failOn]);
    const quote = (s: string) => (/\s/.test(s) ? JSON.stringify(s) : s);
    return {
      label,
      fixTarget: opts.repo ? `--repo ${quote(label)}` : quote(label),
      filesScanned: extracted.filesScanned,
      skipped: extracted.skipped,
      lock,
      match,
      elapsedMs: Math.round(performance.now() - started),
      exitCode: failing.length > 0 ? 1 : 0,
    };
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

/** `url` with any credentials (`https://user:token@host/...`) removed, for output and error messages. */
export function redactUrl(url: string): string {
  return url.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");
}

/**
 * Shallow-clone `url` into a new temp folder and return it; the caller removes it. A failed clone
 * leaves nothing behind, and its error names the URL without credentials.
 */
export function cloneShallow(url: string, prefix: string): string {
  if (url.startsWith("-")) throw new Error(`--repo: not a repository URL: ${redactUrl(url)}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  let stderr: string;
  try {
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--quiet", "--", url, dir], { stdio: ["ignore", "ignore", "pipe"] });
    return dir;
  } catch (err) {
    // Not rethrown or kept as the cause: its message is the full command line, credentials included.
    stderr = String((err as { stderr?: Buffer | string }).stderr ?? "").trim();
  }
  rmSync(dir, { recursive: true, force: true });
  throw new Error(`git clone ${redactUrl(url)} failed${stderr ? `: ${redactUrl(stderr)}` : ""}`);
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
    possible: o.match.possible.map(finding),
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
