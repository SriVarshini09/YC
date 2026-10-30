/**
 * Canary back-test (execution plan P-11): run each case of datasets/canary-backtest.json through the canary's diff and
 * classifier, and write results/canary-backtest.json and the table in CANARY-BACKTEST.md. Offline: nothing is fetched.
 *
 *   pnpm --filter @shapi/bench bench:canary-backtest
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktestCase, type BacktestCase } from "@shapi/bench";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const dataset = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "canary-backtest.json"), "utf8")) as { cycleMinutes: number; cases: BacktestCase[] };
const results = dataset.cases.map((c) => runBacktestCase(c, dataset.cycleMinutes));
writeFileSync(path.join(benchRoot, "results", "canary-backtest.json"), `${JSON.stringify({ cycleMinutes: dataset.cycleMinutes, results }, null, 2)}\n`);

const cycles = (n: number | null) => (n === null ? "not seen" : `${n} (${n * dataset.cycleMinutes} min)`);
const rows = results.map(
  (r) =>
    `| ${r.title} | ${r.expected.changeClass}, ${r.expected.severity} | ${r.classified.changeClass ?? "none"}, ${r.classified.severity ?? "-"}${r.classified.breaking ? ", breaking" : ""} | ${r.classMatches ? "yes" : "**no**"} | ${r.severityMatches ? "yes" : "no"} | ${r.probe ? `\`${r.probe}\`` : "none"} | ${r.probe ? cycles(r.cyclesNow) : "no probe"} | ${cycles(r.cyclesWithProbe)} |`,
);
const table = [
  "<!-- table:start -->",
  `One probe cycle is ${dataset.cycleMinutes} minutes (the canary's default interval). Results: [results/canary-backtest.json](results/canary-backtest.json).`,
  "",
  "| Case | Expected (reviewed advisory) | Classified by the canary | Class matches | Severity matches | Probe today | Cycles to see it today | With the probe it needs |",
  "|---|---|---|---|---|---|---|---|",
  ...rows,
  "<!-- table:end -->",
].join("\n");
const doc = path.join(benchRoot, "CANARY-BACKTEST.md");
writeFileSync(doc, readFileSync(doc, "utf8").replace(/<!-- table:start -->[\s\S]*<!-- table:end -->/, table));
for (const r of results) console.log(`${r.id}: ${r.classified.changeClass ?? "none"}/${r.classified.severity ?? "-"} (class ${r.classMatches ? "matches" : "differs"}, severity ${r.severityMatches ? "matches" : "differs"}), now ${r.cyclesNow ?? "-"}, with probe ${r.cyclesWithProbe ?? "-"}\n  ${r.classified.changes.join("\n  ")}`);
