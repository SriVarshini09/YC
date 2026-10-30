/**
 * The Okapi head-to-head (execution plan P-04): scan the base commit of every public pull request Okapi opened,
 * read only, and compare SHAPI's findings with what Okapi changed. Writes results/okapi/<shapi version>/<dataset
 * hash>.json and the table in OKAPI.md. Nothing in the repositories is run, and no pull request is opened.
 *
 *   pnpm --filter @shapi/bench bench:okapi
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdvisories, type MatchResult } from "@shapi/core";
import { loadPythonParser } from "@shapi/extractor";
import { okapiRow, okapiTable, scanRepo, type OkapiPr, type OkapiRow } from "@shapi/bench";
import { githubToken } from "./github.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const repoRoot = path.resolve(benchRoot, "..", "..");
const datasetFile = path.join(benchRoot, "datasets", "okapi-prs.json");
const raw = readFileSync(datasetFile, "utf8");
const dataset = JSON.parse(raw) as { name: string; version: string; prs: OkapiPr[] };
const datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const advisories = loadAdvisories(path.join(repoRoot, "advisories"));
const cliPackage = JSON.parse(readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8")) as { version: string };
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const token = githubToken();
await loadPythonParser();

// Several PRs share a base commit: each commit is scanned once.
const scans = new Map<string, Promise<{ callSites: number; match: MatchResult }>>();
const rows: (OkapiRow & { callSites?: number })[] = [];
for (const pr of dataset.prs) {
  const key = `${pr.repo}@${pr.base}`;
  if (!scans.has(key)) scans.set(key, scanRepo({ repo: pr.repo, sha: pr.base, advisories, token }));
  try {
    const scan = await scans.get(key)!;
    rows.push({ ...okapiRow(pr, scan.match), callSites: scan.callSites });
  } catch (err) {
    rows.push(okapiRow(pr, undefined, err instanceof Error ? err.message : String(err)));
  }
  const row = rows.at(-1)!;
  console.log(`${row.pr}  ${row.verdict}  advisory ${row.advisoryPresent ? "yes" : "no"}  ${row.fixAgreement}${row.error ? `  error: ${row.error}` : ""}`);
}

const count = (f: (r: OkapiRow) => boolean) => rows.filter(f).length;
const summary = {
  prs: rows.length,
  repositories: new Set(dataset.prs.map((p) => p.repo)).size,
  scannedLanguage: count((r) => r.verdict !== "not scanned"),
  advisoryPresent: count((r) => r.advisoryPresent),
  flagged: count((r) => r.verdict === "affected" || r.verdict === "possible"),
  flaggedInOkapisFiles: count((r) => (r.verdict === "affected" || r.verdict === "possible") && r.sameFile),
  missed: count((r) => r.verdict === "missed" || r.verdict === "exposed"),
  otherFindings: count((r) => r.otherFindings.length > 0),
  sameFixTarget: count((r) => r.fixAgreement === "same target"),
  errors: count((r) => Boolean(r.error)),
};
const out = path.join(benchRoot, "results", "okapi", cliPackage.version, `${datasetHash}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ dataset: `${dataset.name} ${dataset.version}`, datasetHash, shapiVersion: cliPackage.version, gitSha, runAt: new Date().toISOString(), summary, rows }, null, 2)}\n`);

// OKAPI.md keeps its prose; the table between the markers is regenerated.
const doc = path.join(benchRoot, "OKAPI.md");
const text = readFileSync(doc, "utf8");
const [start, end] = ["<!-- table:start -->", "<!-- table:end -->"];
const table = `${start}\nRun on ${new Date().toISOString().slice(0, 10)} with SHAPI ${cliPackage.version} (git ${gitSha.slice(0, 7)}), dataset \`${datasetHash}\`. Results: [results/okapi/${cliPackage.version}/${datasetHash}.json](results/okapi/${cliPackage.version}/${datasetHash}.json).\n\n${okapiTable(dataset.prs, rows)}\n${end}`;
writeFileSync(doc, text.replace(new RegExp(`${start}[\\s\\S]*${end}`), table));
console.log(JSON.stringify(summary, null, 2));
console.log(`written to ${path.relative(process.cwd(), out)} and OKAPI.md`);
