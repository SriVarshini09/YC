import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiLock, loadAdvisories, matchAdvisories, pathMatches, type Advisory, type Finding } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore, type ResponseShape } from "@shapi/shapes";
import { loadRecording, replay } from "@shapi/canary";
import { RECIPES, claudeFixer, repairCallSite, type RepairResult } from "@shapi/repair";
import { authFromEnv, octokitFor, prBranch, prTitle, renderPrBody, repoFromUrl, upsertFixPr, type OpenedPullRequest } from "@shapi/github-app";
import { DEFAULT_ADVISORIES } from "./scan";

/** Recorded response sequences shipped with SHAPI: packages/cli/{src,dist}/ → ../../../fixtures/recordings. */
export const DEFAULT_RECORDINGS = fileURLToPath(new URL("../../../fixtures/recordings", import.meta.url));

export interface FixOptions {
  repo?: string;
  advisories?: string;
  advisory?: string;
  recordings?: string;
  db?: string;
  llm?: boolean;
  write?: boolean;
  pr?: boolean;
  now?: string;
}

export interface FixOutcome {
  finding: Finding;
  shapeSource?: string;
  result?: RepairResult;
  pr?: OpenedPullRequest;
  skipped?: string;
}

export interface FixDeps {
  log: (line: string) => void;
  /** Injected for tests; defaults to the real GitHub delivery. */
  deliver?: (repo: string, files: { path: string; content: string }[], meta: { title: string; body: string; branch: string; commitMessage: string }) => Promise<OpenedPullRequest>;
}

/** Scan, repair every affected call site test-first, and optionally write the fix locally or open a PR. */
export async function fix(target: string | undefined, opts: FixOptions, deps: FixDeps): Promise<FixOutcome[]> {
  let dir = path.resolve(target ?? ".");
  let cleanup: string | undefined;
  let remote = opts.repo ? repoFromUrl(opts.repo) : undefined;
  if (opts.repo) {
    if (opts.repo.startsWith("-")) throw new Error(`--repo: not a repository URL: ${opts.repo}`);
    cleanup = mkdtempSync(path.join(os.tmpdir(), "shapi-fix-"));
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--quiet", "--", opts.repo, cleanup], { stdio: ["ignore", "ignore", "pipe"] });
    dir = cleanup;
  } else if (opts.pr) {
    remote = originRepo(dir);
  }
  if (opts.pr && !remote) throw new Error("--pr needs a GitHub repository: pass --repo <github url> or run inside a clone whose origin is on GitHub");

  try {
    const advisories = loadAdvisories(opts.advisories ?? DEFAULT_ADVISORIES).filter((a) => !opts.advisory || a.id === opts.advisory);
    const lock = createApiLock(extractCallSites(dir), "shapi fix");
    const now = opts.now ? new Date(opts.now) : new Date();
    const { affected } = matchAdvisories(lock, advisories, { now });
    if (affected.length === 0) deps.log("No affected call sites: nothing to fix.");

    const llm = opts.llm ? claudeFixer() : undefined;
    const outcomes: FixOutcome[] = [];
    for (const finding of affected) {
      const { advisory, callSite } = finding;
      const where = `${callSite.file}:${callSite.line}`;
      const shapes = findShapes(advisory, opts);
      if (!shapes) {
        const skipped = "no before/after shapes for this endpoint (record them with the canary, or add a recording)";
        deps.log(`SKIP  ${where}  ${advisory.id}: ${skipped}`);
        outcomes.push({ finding, skipped });
        continue;
      }
      const result = await repairCallSite({ repoDir: dir, advisory, callSite, before: shapes.before, after: shapes.after, recipes: RECIPES, llm });
      const outcome: FixOutcome = { finding, shapeSource: shapes.source, result };
      outcomes.push(outcome);
      deps.log(`${result.status.toUpperCase().padEnd(15)} ${where}  ${advisory.id}${result.method ? `  via ${result.method}` : ""}${result.reason ? `: ${result.reason}` : ""}`);
      for (const a of result.attempts) deps.log(`    ${a.method}: ${a.outcome} (${a.detail})`);

      if (result.status !== "fixed") continue;
      for (const c of result.changes) deps.log(`    ${c.before ? "M" : "A"} ${c.file}`);
      const files = result.changes.map((c) => ({ path: c.file, content: c.after }));

      if (opts.write) {
        for (const f of files) {
          mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
          writeFileSync(path.join(dir, f.path), f.content);
        }
        deps.log(`    wrote ${files.length} files into ${dir}`);
      }
      if (opts.pr && remote) {
        const meta = {
          title: prTitle(advisory),
          branch: prBranch(advisory),
          commitMessage: `fix: ${advisory.title}\n\nAdvisory ${advisory.id}. Contract test ${result.test?.file} fails before this change and passes after.`,
          body: renderPrBody({
            advisory,
            callSite,
            result,
            affectedInRepo: affected.filter((f) => f.advisory.id === advisory.id).length,
            shapeSource: shapes.source,
          }),
        };
        outcome.pr = await (deps.deliver ?? deliverToGitHub)(remote, files, meta);
        deps.log(`    pull request: ${outcome.pr.url}`);
      }
    }
    return outcomes;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

async function deliverToGitHub(
  repo: string,
  files: { path: string; content: string }[],
  meta: { title: string; body: string; branch: string; commitMessage: string },
): Promise<OpenedPullRequest> {
  const auth = authFromEnv();
  if (!auth) throw new Error("no GitHub credentials: set GITHUB_TOKEN, log in with `gh auth login`, or configure the SHAPI GitHub App variables");
  // Same branch per advisory as the GitHub App: a rerun updates the PR instead of failing on the existing branch.
  const outcome = await upsertFixPr(octokitFor(auth), { repo, files, ...meta, labels: ["shapi"] });
  if (outcome.action === "skipped") throw new Error(`not delivered: ${outcome.reason}${outcome.url ? ` (${outcome.url})` : ""}`);
  return { url: outcome.url, number: outcome.number, branch: outcome.branch, commit: outcome.commit };
}

/** Before/after shapes for an advisory: the shape store first (live canary data), then the recordings folder. */
function findShapes(advisory: Advisory, opts: FixOptions): { before: ResponseShape; after: ResponseShape; source: string } | undefined {
  if (opts.db && existsSync(opts.db)) {
    const store = ShapeStore.open(opts.db);
    try {
      for (const e of store.endpoints()) {
        if (e.provider !== advisory.provider || !pathMatches(e.endpoint, advisory.endpoint)) continue;
        if (advisory.endpoint.method !== "*" && e.method !== advisory.endpoint.method) continue;
        const after = store.latest(e.provider, e.method, e.endpoint, e.source);
        const before = store.previousDistinct(e.provider, e.method, e.endpoint, e.source);
        if (before && after) return { before: before.shape, after: after.shape, source: `${e.source} (${opts.db})` };
      }
    } finally {
      store.close();
    }
  }
  const dir = opts.recordings ?? DEFAULT_RECORDINGS;
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const recording = loadRecording(path.join(dir, name));
    if (recording.provider !== advisory.provider || !pathMatches(recording.endpoint, advisory.endpoint)) continue;
    if (advisory.endpoint.method !== "*" && recording.method !== advisory.endpoint.method) continue;
    const store = ShapeStore.open(":memory:");
    const replayed = replay(recording, store, process.env.SHAPI_SHAPE_SECRET ?? "shapi-dev-secret");
    store.close();
    if (replayed.before) return { before: replayed.before.shape, after: replayed.after.shape, source: `recording ${name}` };
  }
  return undefined;
}

function originRepo(dir: string): string | undefined {
  try {
    return repoFromUrl(execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}
