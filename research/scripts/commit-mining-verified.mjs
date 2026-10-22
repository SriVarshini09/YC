#!/usr/bin/env node
// Turn the hand classification (research/data/commit-mining-verified.json) into per-repo rows and lag statistics,
// using the raw candidates saved by commit-mining.mjs --raw.
//
// Usage: node research/scripts/commit-mining-verified.mjs <raw.json> [--out research/data]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rawFile = process.argv[2];
if (!rawFile) throw new Error("usage: commit-mining-verified.mjs <raw.json> [--out dir]");
const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "research/data";
const raw = JSON.parse(readFileSync(rawFile, "utf8"));
const verified = JSON.parse(readFileSync(path.join(OUT, "commit-mining-verified.json"), "utf8"));
const CHANGE = { "github-workflow-dispatch-204-to-200": "2025-12-19", "quickbooks-minorversion-below-75": "2025-08-01" };

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? null : s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const rows = [];
const stats = {};
for (const [incident, classes] of Object.entries(verified)) {
  if (!CHANGE[incident]) continue;
  stats[incident] = {};
  for (const [cls, repos] of Object.entries(classes)) {
    const lags = [];
    for (const repo of repos) {
      // The first commit in that repo whose subject line mentions the change (what was reviewed).
      const c = raw[incident]
        .filter((x) => x.repo === repo)
        .sort((a, b) => a.date.localeCompare(b.date))
        .find((x) => /(dispatch|minor ?version)/i.test(x.message.split("\n")[0]));
      if (!c) throw new Error(`${incident}/${repo}: not in raw candidates`);
      const lag = days(CHANGE[incident], c.date);
      lags.push(lag);
      rows.push({ incident, class: cls, repo, date: c.date, lag_days: lag, url: c.url, subject: c.message.split("\n")[0].slice(0, 160) });
    }
    stats[incident][cls] = { repos: repos.length, median_lag_days: median(lags), min_lag_days: Math.min(...lags), max_lag_days: Math.max(...lags) };
  }
}

const cols = ["incident", "class", "repo", "date", "lag_days", "url", "subject"];
writeFileSync(
  path.join(OUT, "commit-mining-verified.csv"),
  [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c]).replaceAll('"', '""')}"`).join(","))].join("\n") + "\n",
);
console.log(JSON.stringify(stats, null, 2));
