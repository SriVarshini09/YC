/**
 * Run SHAPI over an APIBreak-Replay dataset: scan each in-scope instance at its base and fix commits and
 * write per-instance verdicts plus the summary to results/<shapi version>/<dataset hash>.json.
 *
 *   pnpm --filter @shapi/bench bench:run -- [--dataset datasets/apibreak-v0.json] [--only <id substring>] [--cache <dir>]
 *
 * As the regression suite (execution plan P-05), CI runs it with --check: it compares the run with baseline.json
 * and exits 1 when a catch is lost or a fix commit is newly flagged. --update-baseline rewrites baseline.json.
 *
 * With --fix (execution plan P-02), every instance flagged `affected` at its base commit is also fixed by SHAPI in a
 * sandbox with the network off, and the run reports the fix rate. It uses E2B when E2B_API_KEY is set (the local
 * sandbox otherwise, which is not isolated: only for SHAPI's own fixtures), and Claude when ANTHROPIC_API_KEY is set,
 * at most --llm-calls calls for the whole run.
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
import { RECIPES, claudeFixer, withCallBudget } from "@shapi/repair";
import { sandboxFromEnv } from "@shapi/sandbox";
import { fixInstance } from "./fix.ts";
import { githubToken } from "./github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: {
    dataset: { type: "string", default: "datasets/apibreak-v0.json" },
    only: { type: "string" },
    cache: { type: "string" },
    check: { type: "boolean", default: false },
    "update-baseline": { type: "boolean", default: false },
    fix: { type: "boolean", default: false },
    "llm-calls": { type: "string", default: "40" },
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
const provider = values.fix ? sandboxFromEnv() : undefined;
const llm = values.fix && process.env.ANTHROPIC_API_KEY ? withCallBudget(claudeFixer(), Number(values["llm-calls"])) : undefined;
if (values.fix) console.log(`fixing in ${provider!.name}, ${llm ? `Claude up to ${values["llm-calls"]} calls` : "recipes only"} (${Object.keys(RECIPES).length} recipes)`);

const results: InstanceResult[] = [];
for (const instance of dataset.instances) {
  if (values.only && !instance.id.includes(values.only)) continue;
  const result = unscanned(instance);
  if (instance.inScope && instance.advisoryId && instance.baseCommit) {
    try {
      result.base = await scanCommit({ repo: instance.repo, sha: instance.baseCommit, advisoryId: instance.advisoryId, advisories, token, cacheDir: values.cache, mirror: true });
      result.fix = await scanCommit({ repo: instance.repo, sha: instance.fixCommit, advisoryId: instance.advisoryId, advisories, token, cacheDir: values.cache, mirror: true });
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    if (provider && result.base === "affected" && !result.error) {
      const advisory = advisories.find((a) => a.id === instance.advisoryId)!;
      const fixed = await fixInstance({ repo: instance.repo, sha: instance.baseCommit, advisory, provider, llm, recordings: path.join(repoRoot, "fixtures", "recordings"), token, cacheDir: values.cache });
      result.fixOutcome = fixed.outcome;
      result.fixDetail = fixed.detail;
    }
    console.log(`${instance.id}  base ${result.base ?? "-"}  fix ${result.fix ?? "-"}${result.fixOutcome ? `  shapi fix ${result.fixOutcome}: ${result.fixDetail}` : ""}${result.error ? `  error: ${result.error}` : ""}`);
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
