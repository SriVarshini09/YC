/**
 * A grep baseline for the leaderboard (execution plan P-15): what a regex search finds, with no parsing. A file is
 * flagged when a line matches the incident's trigger (`TRIGGER_EVIDENCE`): for GitHub, a `204` in a file that also
 * says `dispatches`; for QuickBooks, a `minorversion` below 75. Writes submissions/grep-baseline.json in the format
 * SUBMISSIONS.md describes, and goes through the same validation and scoring as any outside submission.
 *
 *   pnpm --filter @shapi/bench bench:baseline-grep -- [--cache <dir>]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TRIGGER_EVIDENCE, scoredIds, withRepoAt, type Dataset, type Submission, type SubmissionVerdict as Verdict } from "@shapi/bench";
import { githubToken } from "./github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const { values } = parseArgs({ options: { cache: { type: "string" }, dataset: { type: "string", default: path.join(pkg, "datasets", "apibreak-v0.json") } } });
const raw = readFileSync(values.dataset, "utf8");
const dataset = JSON.parse(raw) as Dataset;
const datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const token = githubToken();
const scored = new Set(scoredIds(dataset));
const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor"]);
const CONTEXT: Record<string, RegExp> = { "github-workflow-dispatch-204-to-200": /dispatches/ };

function grep(root: string, advisoryId: string): boolean {
  const trigger = TRIGGER_EVIDENCE[advisoryId]!;
  const context = CONTEXT[advisoryId];
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (walk(full)) return true;
      } else if (st.size < 1_000_000) {
        const text = readFileSync(full, "utf8");
        if (text.includes("\u0000")) continue;
        if ((!context || context.test(text)) && text.split("\n").some((l) => trigger.test(l))) return true;
      }
    }
    return false;
  };
  return walk(root);
}

const results: Submission["results"] = [];
for (const i of dataset.instances) {
  if (!scored.has(i.id)) continue;
  const at = async (sha: string): Promise<Verdict> => {
    try {
      return (await withRepoAt({ repo: i.repo, sha, token, cacheDir: values.cache, mirror: true }, (root) => grep(root, i.advisoryId!))) ? "flagged" : "clear";
    } catch {
      return "error";
    }
  };
  const r = { id: i.id, base: await at(i.baseCommit!), fix: await at(i.fixCommit) };
  results.push(r);
  console.log(`${r.base.padEnd(7)} ${r.fix.padEnd(7)} ${i.id}`);
}

const submission: Submission = {
  tool: "grep baseline",
  version: "1",
  url: "https://github.com/SriVarshini09/YC/blob/main/packages/bench/scripts/baseline-grep.ts",
  submittedBy: "SHAPI maintainers",
  runAt: new Date().toISOString(),
  dataset: dataset.name,
  datasetHash,
  command: "pnpm --filter @shapi/bench bench:baseline-grep",
  results,
};
writeFileSync(path.join(pkg, "submissions", "grep-baseline.json"), JSON.stringify(submission, null, 2) + "\n");
