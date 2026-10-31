/**
 * Score every submission in submissions/ and SHAPI's latest benchmark run, and rewrite the table in LEADERBOARD.md
 * (execution plan P-15). Fails, naming the problems, when a submission doesn't cover exactly the scored instances of
 * the current dataset. `--check` only validates, and fails when LEADERBOARD.md is out of date (CI runs it).
 *
 *   pnpm --filter @shapi/bench bench:leaderboard [-- --check]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leaderboardTable, scoreSubmission, scoredIds, shapiSubmission, submissionProblems, type Dataset, type Submission } from "@shapi/bench";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const check = process.argv.includes("--check");
const raw = readFileSync(path.join(pkg, "datasets", "apibreak-v0.json"), "utf8");
const dataset = JSON.parse(raw) as Dataset;
const target = { name: dataset.name, hash: createHash("sha256").update(raw).digest("hex").slice(0, 12), scored: scoredIds(dataset) };

const submissions: Submission[] = [];
const problems: string[] = [];
for (const f of readdirSync(path.join(pkg, "submissions")).filter((f) => f.endsWith(".json")).sort()) {
  const s = JSON.parse(readFileSync(path.join(pkg, "submissions", f), "utf8")) as Submission;
  const p = submissionProblems(s, target);
  if (p.length) problems.push(...p.map((x) => `submissions/${f}: ${x}`));
  else submissions.push(s);
}

// SHAPI's row: its latest run on this dataset.
const runs = readdirSync(path.join(pkg, "results"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
  .flatMap((d) => readdirSync(path.join(pkg, "results", d.name)).filter((f) => f === `${target.hash}.json`).map((f) => JSON.parse(readFileSync(path.join(pkg, "results", d.name, f), "utf8"))))
  .sort((a, b) => String(b.runAt).localeCompare(String(a.runAt)));
if (runs[0]) submissions.push(shapiSubmission(runs[0], target.scored));

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const file = path.join(pkg, "LEADERBOARD.md");
const current = readFileSync(file, "utf8");
const start = "<!-- leaderboard:start -->";
const end = "<!-- leaderboard:end -->";
const table = `${start}\n${leaderboardTable(submissions.map(scoreSubmission))}\n${end}`;
const next = current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), table);
if (check) {
  if (next !== current) {
    console.error("LEADERBOARD.md is out of date: run pnpm --filter @shapi/bench bench:leaderboard");
    process.exit(1);
  }
  console.log(`${submissions.length} entries, all valid`);
} else {
  writeFileSync(file, next);
  console.log(`${submissions.length} entries written to LEADERBOARD.md`);
}
