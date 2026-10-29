import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApiLock, loadAdvisories, matchAdvisories, pathMatches, type Advisory, type Finding } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore, diffShapes, type ResponseShape } from "@shapi/shapes";
import { loadRecording, replay } from "@shapi/canary";
import { RECIPES, claudeFixer, localWorkspace, repairAdvisory, withCallBudget, type RepairResult } from "@shapi/repair";
import { authFromEnv, octokitFor, prBranch, prTitle, renderPrBody, repoFromUrl, upsertFixPr, type OpenedPullRequest } from "@shapi/github-app";
import { DEFAULT_ADVISORIES, cloneShallow } from "./scan";
import { bundledDir } from "./paths";

/** Recorded response sequences shipped with SHAPI (the published package's recordings/, or fixtures/recordings in the monorepo). */
export const DEFAULT_RECORDINGS = bundledDir("recordings", "fixtures/recordings");

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
  deliver?: (repo: string, files: DeliveredFile[], meta: { title: string; body: string; branch: string; commitMessage: string; baseSha?: string }) => Promise<OpenedPullRequest>;
}

/** A file for the PR: its fixed content, and the content the fix was computed from ("" for a new file). */
export interface DeliveredFile {
  path: string;
  content: string;
  before: string;
}

/** Scan, repair every affected call site test-first, and optionally write the fix locally or open a PR. */
export async function fix(target: string | undefined, opts: FixOptions, deps: FixDeps): Promise<FixOutcome[]> {
  // Every check runs before cloning, so a refused run leaves no temp clone behind.
  if (opts.repo && opts.write) throw new Error("--write writes into a local repository; with --repo, use --pr to deliver the fix");
  const remote = opts.repo ? repoFromUrl(opts.repo) : opts.pr ? originRepo(path.resolve(target ?? ".")) : undefined;
  if (opts.pr && !remote) throw new Error("--pr needs a GitHub repository: pass --repo <github url> or run inside a clone whose origin is on GitHub");
  const all = loadAdvisories(opts.advisories ?? DEFAULT_ADVISORIES);
  if (opts.advisory && !all.some((a) => a.id === opts.advisory)) throw new Error(`unknown advisory ${opts.advisory}`);
  const cleanup = opts.repo ? cloneShallow(opts.repo, "shapi-fix-") : undefined;
  const dir = cleanup ?? path.resolve(target ?? ".");

  try {
    const advisories = all.filter((a) => !opts.advisory || a.id === opts.advisory);
    // A fresh clone is exactly a commit on GitHub: the PR is built on it. A local checkout may hold
    // unpushed or uncommitted work, so its PR goes on the base's head, refused if a changed file differs there.
    const baseSha = cleanup ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim() : undefined;
    const lock = createApiLock(extractCallSites(dir), "shapi fix");
    const now = opts.now ? new Date(opts.now) : new Date();
    const { affected } = matchAdvisories(lock, advisories, { now });
    if (affected.length === 0) deps.log("No affected call sites: nothing to fix.");

    const llm = opts.llm ? withCallBudget(claudeFixer()) : undefined;
    const outcomes: FixOutcome[] = [];
    // One repair per advisory covering all of its call sites, so --write and --pr carry them together.
    const byAdvisory = new Map<string, Finding[]>();
    for (const f of affected) byAdvisory.set(f.advisory.id, [...(byAdvisory.get(f.advisory.id) ?? []), f]);
    for (const findings of byAdvisory.values()) {
      const advisory = findings[0]!.advisory;
      // With an advisory fix the contract test is built from the fix itself; otherwise it needs recorded responses.
      const shapes: { before?: ResponseShape; after?: ResponseShape; source: string } | undefined = advisory.fix ? { source: FIX_SOURCE } : findShapes(advisory, opts);
      if (!shapes) {
        const skipped = "no before/after shapes for this endpoint (record them with the canary, or add a recording)";
        for (const finding of findings) {
          deps.log(`SKIP  ${finding.callSite.file}:${finding.callSite.line}  ${advisory.id}: ${skipped}`);
          outcomes.push({ finding, skipped });
        }
        continue;
      }
      // The temp copy holds the whole checkout (.env files too): it goes as soon as the repair is done.
      const workspace = localWorkspace(dir);
      const repair = await repairAdvisory({ workspace, advisory, callSites: findings.map((f) => f.callSite), before: shapes.before, after: shapes.after, recipes: RECIPES, llm }).finally(() => workspace.dispose());
      const mine: FixOutcome[] = [];
      for (const { callSite, result } of repair.sites) {
        const finding = findings.find((f) => f.callSite.file === callSite.file && f.callSite.line === callSite.line && f.callSite.column === callSite.column)!;
        mine.push({ finding, shapeSource: shapes.source, result });
        deps.log(`${result.status.toUpperCase().padEnd(15)} ${callSite.file}:${callSite.line}  ${advisory.id}${result.method ? `  via ${result.method}` : ""}${result.reason ? `: ${result.reason}` : ""}`);
        for (const a of result.attempts) deps.log(`    ${a.method}: ${a.outcome} (${a.detail})`);
      }
      outcomes.push(...mine);
      if (!repair.changes.length) continue;
      for (const c of repair.changes) deps.log(`    ${c.before ? "M" : "A"} ${c.file}`);
      // What each file held before the fix, read before --write changes it.
      const files: DeliveredFile[] = repair.changes.map((c) => {
        const local = path.join(dir, c.file);
        return { path: c.file, content: c.after, before: existsSync(local) ? readFileSync(local, "utf8") : "" };
      });

      if (opts.write) {
        for (const f of files) {
          mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
          writeFileSync(path.join(dir, f.path), f.content);
        }
        deps.log(`    wrote ${files.length} files into ${dir}`);
      }
      if (opts.pr && remote) {
        const fixed = repair.sites.filter((s) => s.result.status === "fixed");
        const meta = {
          title: prTitle(advisory),
          branch: prBranch(advisory),
          commitMessage: `fix: ${advisory.title}\n\nAdvisory ${advisory.id}, ${fixed.length} of ${repair.sites.length} call sites. Contract tests ${fixed.map((s) => s.result.test?.file).join(", ")} fail before this change and pass after.`,
          body: renderPrBody({ advisory, repair, shapeSource: shapes.source }),
          baseSha,
        };
        const pr = await (deps.deliver ?? deliverToGitHub)(remote, files, meta);
        for (const o of mine) if (o.result?.status === "fixed") o.pr = pr;
        deps.log(`    pull request: ${pr.url}`);
      }
    }
    return outcomes;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

async function deliverToGitHub(
  repo: string,
  files: DeliveredFile[],
  meta: { title: string; body: string; branch: string; commitMessage: string; baseSha?: string },
): Promise<OpenedPullRequest> {
  const auth = authFromEnv();
  if (!auth) throw new Error("no GitHub credentials: set GITHUB_TOKEN, log in with `gh auth login`, or configure the SHAPI GitHub App variables");
  // Same branch per advisory as the GitHub App: a rerun updates the PR instead of failing on the existing branch.
  const outcome = await upsertFixPr(octokitFor(auth), { repo, files, ...meta, labels: ["shapi"] });
  if (outcome.action === "skipped") throw new Error(`not delivered: ${outcome.reason}${outcome.url ? ` (${outcome.url})` : ""}`);
  return { url: outcome.url, number: outcome.number, branch: outcome.branch, commit: outcome.commit };
}

/** Shown as the shape source when the contract test is built from the advisory's `fix`. */
export const FIX_SOURCE = "built from the advisory's fix and the fields the code reads";

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
        // Only a change of the advisory's kind: another change on the endpoint (a header, say) cannot make its contract test fail.
        if (before && after && diffShapes(before.shape, after.shape).changes.some((c) => c.changeClass === advisory.changeClass)) return { before: before.shape, after: after.shape, source: `${e.source} (${opts.db})` };
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
