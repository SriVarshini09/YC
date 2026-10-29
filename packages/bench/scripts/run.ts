/**
 * Run SHAPI over an APIBreak-Replay dataset: scan each in-scope instance at its base and fix commits and
 * write per-instance verdicts plus the summary to results/<shapi version>/<dataset hash>.json.
 *
 *   pnpm --filter @shapi/bench bench:run -- [--dataset datasets/apibreak-v0.json] [--only <id substring>]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadAdvisories } from "@shapi/core";
import { loadPythonParser } from "@shapi/extractor";
import { scanCommit, summarize, unscanned, type Dataset, type InstanceResult } from "@shapi/bench";
import { githubToken } from "./github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { dataset: { type: "string", default: "datasets/apibreak-v0.json" }, only: { type: "string" } } });

const raw = readFileSync(path.resolve(values.dataset), "utf8");
const dataset = JSON.parse(raw) as Dataset;
const datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const advisories = loadAdvisories(path.join(repoRoot, "advisories"));
const cliPackage = JSON.parse(readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8")) as { version: string };
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const token = githubToken();
await loadPythonParser();

const results: InstanceResult[] = [];
for (const instance of dataset.instances) {
  if (values.only && !instance.id.includes(values.only)) continue;
  const result = unscanned(instance);
  if (instance.inScope && instance.advisoryId && instance.baseCommit) {
    try {
      result.base = await scanCommit({ repo: instance.repo, sha: instance.baseCommit, advisoryId: instance.advisoryId, advisories, token });
      result.fix = await scanCommit({ repo: instance.repo, sha: instance.fixCommit, advisoryId: instance.advisoryId, advisories, token });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    console.log(`${instance.id}  base ${result.base ?? "-"}  fix ${result.fix ?? "-"}${result.error ? `  error: ${result.error}` : ""}`);
  }
  results.push(result);
}

const summary = summarize(results);
const out = path.join(here, "..", "results", cliPackage.version, `${datasetHash}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ dataset: `${dataset.name} ${dataset.version}`, datasetHash, shapiVersion: cliPackage.version, gitSha, runAt: new Date().toISOString(), summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`written to ${path.relative(process.cwd(), out)}`);
