/**
 * Mine candidate APIBreak-Replay instances from public GitHub commits (execution plan P-14): commit-message
 * searches per incident, then each candidate's diff decides its label. The labels are automatic and wait for a
 * hand review before they are trusted (METHODOLOGY.md says which instances are auto-classified).
 *
 * - Meta Graph: a scanned source file drops `v20.0` or `v21.0` next to Graph/Meta/version wording for a newer
 *   version: `version-bump` for the matching sunset advisory. Bumps from older versions are kept, unscored.
 * - GitHub workflow_dispatch: the fix removes a check for `204` (`accept-200`); otherwise unscored.
 * - QuickBooks: the fix removes a `minorversion` below 75 and adds one at 75 or more (`moved-to-75`).
 *
 * Writes a CSV in the format scripts/build.ts reads. Repositories already in an earlier dataset are skipped.
 *
 *   pnpm --filter @shapi/bench bench:mine -- --out datasets/apibreak-v1-mined.csv [--exclude datasets/apibreak-v0.json] [--max 150]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SCANNED_EXTENSIONS, type Dataset } from "@shapi/bench";
import { githubToken, gh as ghOnce } from "./github.ts";

/** gh(), waiting out GitHub's rate limits (403/429) instead of losing the candidate: up to an hour and a half. */
async function gh<T>(apiPath: string, auth: string | undefined): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ghOnce<T>(apiPath, auth);
    } catch (err) {
      const limited = /: (403|429)$/.test(err instanceof Error ? err.message : "");
      if (!limited || attempt >= 90) throw err;
      if (attempt === 0) console.log(`rate limited; waiting (${apiPath.split("?")[0]})`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
}

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { out: { type: "string", default: "datasets/apibreak-v1-mined.csv" }, exclude: { type: "string", default: "datasets/apibreak-v0.json" }, max: { type: "string", default: "150" }, only: { type: "string" } },
});
const token = githubToken();
const maxPerIncident = Number(values.max);
const known = new Set((JSON.parse(readFileSync(values.exclude, "utf8")) as Dataset).instances.map((i) => `${i.incident} ${i.repo.toLowerCase()}`));

interface Commit {
  sha: string;
  html_url: string;
  commit: { message: string; committer: { date: string } };
  repository: { full_name: string; fork: boolean };
}
interface Row {
  incident: string;
  class: string;
  repo: string;
  date: string;
  lag_days: string;
  url: string;
  subject: string;
}

const day = 86_400_000;
const lag = (date: string, since: string) => String(Math.round((Date.parse(date) - Date.parse(since)) / day));

type Classify = (files: { filename: string; patch?: string }[]) => { incident: string; class: string; since: string } | undefined;

const removed = (patch: string) => patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
const added = (patch: string) => patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
const scanned = (f: { filename: string }) => SCANNED_EXTENSIONS.test(f.filename);

const GRAPH_WORDS = /graph|facebook|instagram|whatsapp|\bmeta\b|api[_-]?version|graph[_-]?version|\bFB_|\bIG_/i;
const metaClassify: Classify = (files) => {
  let from: number | undefined;
  let to = 0;
  for (const f of files.filter(scanned)) {
    for (const l of removed(f.patch ?? "")) {
      const m = /\bv(1\d|2\d)\.0\b/.exec(l);
      if (m && GRAPH_WORDS.test(l)) from = Math.min(from ?? 99, Number(m[1]));
    }
    for (const l of added(f.patch ?? "")) {
      const m = /\bv(2\d)\.0\b/.exec(l);
      if (m && GRAPH_WORDS.test(l)) to = Math.max(to, Number(m[1]));
    }
  }
  if (from === undefined || to <= from) return undefined;
  if (from === 20) return { incident: "meta-graph-v20-sunset", class: "version-bump", since: "2026-09-24" };
  if (from === 21) return { incident: "meta-graph-v21-sunset", class: "version-bump", since: "2027-01-21" };
  if (from < 20) return { incident: "meta-graph-older-version", class: "older-version", since: "2026-09-24" };
  return undefined;
};

const dispatchClassify: Classify = (files) => {
  const touches = files.some((f) => /dispatch/i.test(f.patch ?? ""));
  if (!touches) return undefined;
  const removes204 = files.filter(scanned).some((f) => removed(f.patch ?? "").some((l) => /\b204\b/.test(l)));
  return { incident: "github-workflow-dispatch-204-to-200", class: removes204 ? "accept-200" : "auto-unverified", since: "2025-12-19" };
};

const qboClassify: Classify = (files) => {
  const old = files.filter(scanned).some((f) => removed(f.patch ?? "").some((l) => /minor_?version["'\s]*[:=,]?\s*["'`]?(?:[0-9]|[1-6][0-9]|7[0-4])(?![0-9])/i.test(l)));
  const current = files.some((f) => added(f.patch ?? "").some((l) => /minor_?version["'\s]*[:=,]?\s*["'`]?(?:7[5-9]|[89][0-9])(?![0-9])/i.test(l)));
  return old && current ? { incident: "quickbooks-minorversion-below-75", class: "moved-to-75", since: "2025-08-01" } : undefined;
};

const SEARCHES: { name: string; classify: Classify; queries: string[]; message: RegExp }[] = [
  {
    name: "meta",
    classify: metaClassify,
    message: /(graph|meta|facebook|instagram|whatsapp)[\s\S]*\bv?2\d|\bv2\d[\s\S]*(graph|meta|facebook|instagram|whatsapp)/i,
    queries: ["graph api v22", "graph api v23", "graph api v24", "graph api v25", "graph api version upgrade", "upgrade graph api", "bump graph api", "facebook graph api version", "meta graph api version", "instagram graph api v2", "whatsapp cloud api v2", "meta api v22", "meta api v23", "meta api v24"],
  },
  { name: "dispatch", classify: dispatchClassify, message: /dispatch/i, queries: ["workflow_dispatch 200", "workflow dispatch 204", "dispatches 200", "dispatch returns 200", "workflow_dispatch status code"] },
  { name: "quickbooks", classify: qboClassify, message: /minor|quickbooks|qbo|intuit/i, queries: ["minorversion 75", "quickbooks minor version", "qbo minorversion"] },
];

const rows: Row[] = [];
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const header = ["incident", "class", "repo", "date", "lag_days", "url", "subject"] as const;
/** Written after every candidate, so an interrupted run keeps what it found. */
const save = () => writeFileSync(values.out!, [header.join(","), ...rows.map((r) => header.map((h) => quote(r[h])).join(","))].join("\n") + "\n");
const seen = new Set<string>();
const counts = new Map<string, number>();
for (const { name, classify, queries, message } of SEARCHES) {
  if (values.only && values.only !== name) continue;
  for (const q of queries) {
    for (let page = 1; page <= 1; page++) {
      let items: Commit[];
      try {
        const res = await gh<{ items: Commit[] }>(`/search/commits?q=${encodeURIComponent(`${q} committer-date:>2025-01-01`)}&per_page=100&page=${page}`, token);
        items = res.items;
      } catch (err) {
        console.log(`search "${q}" page ${page}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      // the search API allows 30 requests a minute
      await new Promise((r) => setTimeout(r, 2500));
      for (const c of items) {
        const repo = c.repository.full_name;
        // the message must be about the change before its diff is fetched (each fetch costs rate limit)
        if (!message.test(c.commit.message)) continue;
        if (c.repository.fork || seen.has(`${repo.toLowerCase()} ${c.sha}`)) continue;
        seen.add(`${repo.toLowerCase()} ${c.sha}`);
        let files: { filename: string; patch?: string }[];
        try {
          files = (await gh<{ files?: { filename: string; patch?: string }[] }>(`/repos/${repo}/commits/${c.sha}`, token)).files ?? [];
        } catch {
          continue;
        }
        const label = classify(files);
        if (!label) continue;
        const key = `${label.incident} ${repo.toLowerCase()}`;
        // one instance per repository and incident, and none already in the earlier dataset
        if (known.has(key) || rows.some((r) => `${r.incident} ${r.repo.toLowerCase()}` === key)) continue;
        if ((counts.get(label.incident) ?? 0) >= maxPerIncident) continue;
        counts.set(label.incident, (counts.get(label.incident) ?? 0) + 1);
        const date = c.commit.committer.date.slice(0, 10);
        rows.push({ incident: label.incident, class: label.class, repo, date, lag_days: lag(date, label.since), url: c.html_url, subject: c.commit.message.split("\n")[0]!.slice(0, 200) });
        console.log(`${label.incident}/${label.class}  ${repo}  ${c.sha.slice(0, 7)}`);
        save();
      }
      if (items.length < 100) break;
    }
  }
}

save();
console.log(`${rows.length} candidates written to ${values.out}: ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")}`);
