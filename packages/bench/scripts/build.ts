/**
 * Build the APIBreak-Replay dataset from the hand-verified commit-mining CSV: one instance per row,
 * with the commit before each fix, the repository's license and its primary language looked up on GitHub.
 *
 *   pnpm --filter @shapi/bench bench:build -- --csv <commit-mining-verified.csv> [--out datasets/apibreak-v0.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evidenceIn, instanceFromRow, parseCsv, type Dataset, type Instance, type VerifiedRow } from "@shapi/bench";
import { githubToken, gh } from "./github.ts";

const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { csv: { type: "string" }, out: { type: "string", default: "datasets/apibreak-v0.json" } } });
if (!values.csv) throw new Error("--csv <commit-mining-verified.csv> is required");

const token = githubToken();
const rows = parseCsv(readFileSync(values.csv, "utf8")) as unknown as VerifiedRow[];
const repoInfo = new Map<string, { license: string | null; language: string | null }>();
const instances: Instance[] = [];
for (const row of rows) {
  const instance = instanceFromRow(row);
  try {
    const commit = await gh<{ parents: { sha: string }[]; files?: { filename: string; patch?: string }[] }>(`/repos/${instance.repo}/commits/${instance.fixCommit}`, token);
    instance.baseCommit = commit.parents[0]?.sha;
    if (instance.inScope && instance.advisoryId) {
      const evidence = evidenceIn(commit.files ?? [], instance.advisoryId);
      if (evidence) instance.evidence = evidence;
      else {
        instance.inScope = false;
        instance.outOfScopeReason = "the fix removes no line with the old behavior, so the code before it may not have been affected";
      }
    }
  } catch (err) {
    // A deleted repository or a force-pushed branch: reported, not dropped (P-07 archives the rest).
    instance.inScope = false;
    instance.outOfScopeReason = `the fix commit is no longer on GitHub (${err instanceof Error ? err.message : String(err)})`;
    instances.push(instance);
    console.log(`${instance.id}  unavailable`);
    continue;
  }
  if (!repoInfo.has(instance.repo)) {
    const repo = await gh<{ language: string | null; license: { spdx_id: string } | null }>(`/repos/${instance.repo}`, token);
    repoInfo.set(instance.repo, { language: repo.language, license: repo.license && repo.license.spdx_id !== "NOASSERTION" ? repo.license.spdx_id : null });
  }
  Object.assign(instance, repoInfo.get(instance.repo));
  instances.push(instance);
  console.log(`${instance.id}  base ${instance.baseCommit?.slice(0, 7) ?? "none"}  ${instance.language ?? "?"}`);
}

const dataset: Dataset = {
  name: "APIBreak-Replay",
  version: "v0",
  description:
    "Public repositories that fixed a third-party API change by hand. SHAPI should flag the call site at the commit before the fix, and not after it.",
  source: "SHAPI commit mining of public GitHub commits, hand-verified on 2026-10-22",
  instances,
};
writeFileSync(path.resolve(values.out), `${JSON.stringify(dataset, null, 2)}\n`);
console.log(`${instances.length} instances, ${instances.filter((i) => i.inScope).length} in scope, written to ${values.out}`);
