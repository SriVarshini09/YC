/**
 * Run SHAPI over an APIBreak-Replay dataset: scan each in-scope instance at its base and fix commits and
 * write per-instance verdicts plus the summary to results/<shapi version>/<dataset hash>.json.
 *
 *   pnpm --filter @shapi/bench bench:run -- [--dataset datasets/apibreak-v0.json] [--only <id substring>] [--cache <dir>]
 *
 * As the regression suite (execution plan P-05), CI runs it with --check: it compares the run with baseline.json
 * and exits 1 when a catch is lost or a fix commit is newly flagged. --update-baseline rewrites baseline.json.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadAdvisories } from "@shapi/core";
import { loadPythonParser } from "@shapi/extractor";
import { baselineFrom, checkAgainstBaseline, gateReport, scanCommit, summarize, unscanned, type Baseline, type Dataset, type InstanceResult } from "@shapi/bench";
import { githubToken } from "./github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: {
    dataset: { type: "string", default: "datasets/apibreak-v0.json" },
    only: { type: "string" },
    cache: { type: "string" },
    check: { type: "boolean", default: false },
    "update-baseline": { type: "boolean", default: false },
  },
});

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
      result.base = await scanCommit({ repo: instance.repo, sha: instance.baseCommit, advisoryId: instance.advisoryId, advisories, token, cacheDir: values.cache });
      result.fix = await scanCommit({ repo: instance.repo, sha: instance.fixCommit, advisoryId: instance.advisoryId, advisories, token, cacheDir: values.cache });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    console.log(`${instance.id}  base ${result.base ?? "-"}  fix ${result.fix ?? "-"}${result.error ? `  error: ${result.error}` : ""}`);
  }
  results.push(result);
}

const summary = summarize(results);
const baselineFile = path.join(here, "..", "baseline.json");
const meta = { dataset: `${dataset.name} ${dataset.version}`, datasetHash, gitSha };

if (values.check) {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;
  const gate = checkAgainstBaseline(baseline, results, datasetHash);
  const report = gateReport(gate, baseline, summary);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  process.exit(gate.passed ? 0 : 1);
}
if (values["update-baseline"]) {
  if (values.only) throw new Error("--update-baseline needs the whole dataset, not --only");
  writeFileSync(baselineFile, `${JSON.stringify(baselineFrom(results, summary, meta), null, 2)}\n`);
  console.log(`baseline written to ${path.relative(process.cwd(), baselineFile)}`);
}

const out = path.join(here, "..", "results", cliPackage.version, `${datasetHash}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ dataset: `${dataset.name} ${dataset.version}`, datasetHash, shapiVersion: cliPackage.version, gitSha, runAt: new Date().toISOString(), summary, results }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`written to ${path.relative(process.cwd(), out)}`);
