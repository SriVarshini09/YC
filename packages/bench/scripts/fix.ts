/**
 * SHAPI's fix of one benchmark instance (execution plan P-02): the repository at its base commit goes into a sandbox
 * (E2B when E2B_API_KEY is set), its dependencies install with only the npm registry reachable, then the network is cut
 * and SHAPI repairs every affected call site test-first, exactly as the GitHub App's fix job does.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createApiLock, matchAdvisories, pathMatches, type Advisory } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { loadRecording, replay } from "@shapi/canary";
import { ShapeStore, type ResponseShape } from "@shapi/shapes";
import { RECIPES, repairAdvisory, withSandboxWorkspace, type LlmFixer } from "@shapi/repair";
import { readSnapshot, type SandboxProvider } from "@shapi/sandbox";
import { withRepoAt, type FixOutcome } from "@shapi/bench";

export interface FixInstanceInput {
  repo: string;
  sha: string;
  advisory: Advisory;
  provider: SandboxProvider;
  llm?: LlmFixer;
  recordings: string;
  token?: string;
  cacheDir?: string;
}

/** The before/after shapes a contract test needs when the advisory carries no fix: a recording of the endpoint. */
function recordedShapes(advisory: Advisory, dir: string): { before: ResponseShape; after: ResponseShape } | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const recording = loadRecording(path.join(dir, name));
    if (recording.provider !== advisory.provider || !pathMatches(recording.endpoint, advisory.endpoint)) continue;
    if (advisory.endpoint.method !== "*" && recording.method !== advisory.endpoint.method) continue;
    const store = ShapeStore.open(":memory:");
    const replayed = replay(recording, store, "shapi-bench");
    store.close();
    if (replayed.before) return { before: replayed.before.shape, after: replayed.after.shape };
  }
  return undefined;
}

export async function fixInstance(input: FixInstanceInput): Promise<{ outcome: FixOutcome; detail: string; method?: "recipe" | "llm"; outOfScope?: number }> {
  const shapes = input.advisory.fix ? {} : recordedShapes(input.advisory, input.recordings);
  if (!shapes) return { outcome: "not-fixed", detail: "no before/after shapes for this endpoint" };
  return withRepoAt({ repo: input.repo, sha: input.sha, token: input.token, cacheDir: input.cacheDir, mirror: true }, async (root) => {
    const lock = createApiLock(extractCallSites(root), "shapi-bench");
    const callSites = matchAdvisories(lock, [input.advisory]).affected.map((f) => f.callSite);
    if (!callSites.length) return { outcome: "not-fixed" as const, detail: "no affected call site" };
    try {
      const repair = await withSandboxWorkspace(input.provider, readSnapshot(root), (workspace) =>
        repairAdvisory({ workspace, advisory: input.advisory, callSites, ...shapes, recipes: RECIPES, llm: input.llm }),
      );
      const detail = repair.sites.map((s) => `${s.callSite.file}:${s.callSite.line} ${s.result.status}${s.result.method ? ` via ${s.result.method}` : ""}${s.result.reason ? ` (${s.result.reason})` : ""}`).join("; ");
      const outcome: FixOutcome = repair.status === "fixed" ? "fixed" : repair.status === "partial" ? "partial" : "not-fixed";
      const fixed = repair.sites.filter((s) => s.result.status === "fixed");
      const method = fixed.length ? (fixed.some((s) => s.result.method === "llm") ? ("llm" as const) : ("recipe" as const)) : undefined;
      return { outcome, detail, ...(method ? { method, outOfScope: fixed.filter((s) => s.result.scope?.status === "out-of-scope").length } : {}) };
    } catch (err) {
      return { outcome: "error" as const, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}
