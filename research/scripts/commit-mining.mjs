#!/usr/bin/env node
// Mine public GitHub commits that fix third-party API breakage.
//
// 1. Incidents: for each provider change SHAPI has an advisory for, find commits that adapt to it and
//    measure the days from the provider's change (or deadline) to each repo's first fix.
// 2. Providers: for each provider, count breakage-related commits over the last 12 months and check a
//    sample for relevance with explicit rules, to estimate how much of the raw count is real.
//
// Usage:
//   node research/scripts/commit-mining.mjs [--out research/data] [--raw raw.json]   search, classify, write
//   node research/scripts/commit-mining.mjs --from-raw raw.json [--out research/data] re-classify saved candidates
//   add --skip-providers to leave out step 2
// Auth: GITHUB_TOKEN, GH_TOKEN, or the gh CLI login. Only public, non-fork repositories are kept.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const OUT = arg("--out") ?? "research/data";
const RAW_OUT = arg("--raw");
const FROM_RAW = arg("--from-raw");
const SKIP_PROVIDERS = process.argv.includes("--skip-providers");
const TODAY = new Date().toISOString().slice(0, 10);
const SINCE_12M = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
const EXCLUDE_OWNERS = new Set(["SriVarshini09"]); // SHAPI's own repos
const PAGES_PER_QUERY = 3; // 100 results per page; search returns at most 1000
const SEARCH_INTERVAL_MS = 2_200; // search API: 30 requests per minute

let token;
const auth = () => (token ??= process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim());

/**
 * Provider changes with a known date, the searches that find candidates, and the rule a commit message must
 * meet to count as adapting to that change. Rules are deliberately strict: a missed fix lowers the count,
 * a false one would inflate it. Precision is checked by hand on a sample (see research/04-commit-mining.md).
 */
const INCIDENTS = [
  {
    id: "github-workflow-dispatch-204-to-200",
    provider: "github",
    changeDate: "2025-12-19",
    kind: "silent change",
    queries: ['"workflow_dispatch" 204', '"workflow_dispatch" 200', '"return_run_details"', '"workflow dispatch" 204', '"dispatches" 204 200'],
    relevant: (m) =>
      /(workflow[_ ]dispatch|dispatches|createWorkflowDispatch|dispatched run|dispatch response)/i.test(m) &&
      (/return_run_details/i.test(m) ||
        /(http |status |returns? |response |accept |expect |got |answers? )\(?20[04]\b/i.test(m) ||
        /\b(204|200) (no content|ok|or 20[04]|and 20[04]|instead)/i.test(m) ||
        /\b20[04] ?(->|→|to) ?20[04]\b/.test(m) ||
        /(workflow_run_id|run[ _-]?id (from|in) the (dispatch )?response|dispatched run|run (id|url) from (the )?dispatch)/i.test(m)),
  },
  {
    id: "quickbooks-minorversion-below-75",
    provider: "quickbooks",
    changeDate: "2025-08-01",
    kind: "silent change",
    queries: ["minorversion 75", '"minorversion=75"', 'quickbooks "minor version"', 'qbo "minorversion"'],
    relevant: (m) =>
      /minor ?version/i.test(m) &&
      /(quickbooks|qbo|intuit)/i.test(m) &&
      !/nfs/i.test(m) &&
      (/\b\d{2} ?(->|→|to) ?7[5-9]\b/.test(m) ||
        /(bump|upgrade|update|raise|move|deprecat|ignored|no longer|centrali[sz]e)[^.\n]{0,40}minor ?version/i.test(m) ||
        /minor ?version[^.\n]{0,40}(bump|upgrade|update|75|deprecat|ignored)/i.test(m)),
  },
  {
    id: "reddit-logged-out-json-403",
    provider: "reddit",
    changeDate: "2026-05-30",
    kind: "silent change",
    queries: ["reddit json 403", "reddit .json blocked", "reddit json oauth 403", "reddit unauthenticated json", "reddit json api blocked"],
    relevant: (m) =>
      /reddit/i.test(m) &&
      /(\b403\b|blocked|forbidden|unauthenticated|logged[- ]?out|no longer (works|public|available)|requires? (oauth|auth)|dead reddit|refuses)/i.test(m) &&
      /(fix|switch|move|migrat|fallback|instead|replace|swap|workaround|via)/i.test(m),
  },
  {
    id: "meta-graph-v20-sunset",
    provider: "meta-graph",
    changeDate: "2026-09-24",
    kind: "announced deadline",
    queries: ['"graph api" v21', '"graph.facebook.com" v21', '"graph api" v22', '"graph.facebook.com" v23', 'facebook "graph api version"'],
    relevant: (m) =>
      /(graph[ .-]?api|graph\.facebook|facebook graph|instagram graph|meta graph|marketing api|meta api)/i.test(m) &&
      (/\bv?2\d\.0 ?(->|→|to) ?v?2\d\.0\b/i.test(m) ||
        /(bump|upgrade|update|move|migrat|switch|raise|current|vigente|latest|deprecat)[^.\n]{0,40}(graph api )?(version|v2\d)/i.test(m) ||
        /(version|v2\d(\.0)?)[^.\n]{0,30}(bump|upgrade|update|deprecat|sunset|expired)/i.test(m)),
  },
  {
    id: "xero-granular-scopes",
    provider: "xero",
    changeDate: "2026-03-02",
    kind: "announced deadline",
    queries: ['xero "granular scopes"', "xero scopes accounting.transactions", 'xero "accounting.invoices"', "xero scope migration"],
    relevant: (m) => /xero/i.test(m) && /(granular|accounting\.transactions|accounting\.(invoices|payments|banktransactions)|scope (change|migration|update)|new scopes)/i.test(m),
  },
];

/** Providers from the research, with names as they appear in commit messages. */
const PROVIDERS = [
  ["github", "GitHub"],
  ["stripe", "Stripe"],
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["meta-graph", "Facebook Graph"],
  ["x", "Twitter"],
  ["shopify", "Shopify"],
  ["slack", "Slack"],
  ["hubspot", "HubSpot"],
  ["quickbooks", "QuickBooks"],
  ["xero", "Xero"],
  ["reddit", "Reddit"],
  ["twilio", "Twilio"],
  ["google", "Google Maps"],
  ["salesforce", "Salesforce"],
];
const PROVIDER_TEMPLATES = [
  (n) => `"${n} api" deprecated`,
  (n) => `"${n} api" "breaking change"`,
  (n) => `"${n} api" "no longer"`,
];

let lastSearch = 0;
async function search(q, page) {
  const wait = lastSearch + SEARCH_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearch = Date.now();
  const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=100&page=${page}&sort=committer-date&order=desc`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${auth()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "shapi-research" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(5_000, reset - Date.now() + 1_000)));
      continue;
    }
    if (res.status === 422) return { total_count: 0, items: [] }; // query GitHub cannot run
    if (!res.ok) throw new Error(`search ${q} page ${page}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error(`search ${q}: gave up after retries`);
}

const keep = (item) => !item.repository.private && !item.repository.fork && !EXCLUDE_OWNERS.has(item.repository.owner.login);
const candidate = (item) => ({
  date: item.commit.committer.date.slice(0, 10),
  repo: item.repository.full_name,
  sha: item.sha,
  url: item.html_url,
  message: item.commit.message.slice(0, 600),
});

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const csv = (rows, cols) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n") + "\n";

/** Calendar-month windows from `since` to today, so no period hides behind the newest-first result cap. */
function monthWindows(since) {
  const out = [];
  let start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${TODAY}T00:00:00Z`);
  while (start <= end) {
    const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const last = new Date(Math.min(next.getTime() - 86_400_000, end.getTime()));
    out.push([start.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]);
    start = next;
  }
  return out;
}

/** Search every incident query month by month; return unique candidate commits per incident, with coverage. */
async function collectIncidentCandidates() {
  const raw = {};
  for (const inc of INCIDENTS) {
    // Look a little before the change: some teams adapt the day it starts, before the date they later learn.
    const since = new Date(Date.parse(inc.changeDate) - 30 * 86_400_000).toISOString().slice(0, 10);
    const seen = new Map();
    let matched = 0;
    let fetched = 0;
    for (const q of inc.queries) {
      for (const [from, to] of monthWindows(since)) {
        for (let page = 1; page <= PAGES_PER_QUERY; page++) {
          const data = await search(`${q} committer-date:${from}..${to}`, page);
          if (page === 1) matched += data.total_count;
          fetched += data.items.length;
          for (const item of data.items.filter(keep)) if (!seen.has(item.sha)) seen.set(item.sha, candidate(item));
          if (data.items.length < 100) break;
        }
      }
    }
    raw[inc.id] = [...seen.values()];
    raw[`${inc.id}#coverage`] = { search_matches: matched, fetched };
    console.error(`${inc.id}: ${seen.size} unique candidate commits (fetched ${fetched} of ${matched} search matches)`);
  }
  return raw;
}

function classifyIncidents(raw) {
  const rows = [];
  const summary = [];
  for (const inc of INCIDENTS) {
    const cands = raw[inc.id] ?? [];
    // One commit per repo: the first one that adapts to the change.
    const firstPerRepo = new Map();
    for (const c of cands) {
      if (!inc.relevant(c.message)) continue;
      const prev = firstPerRepo.get(c.repo);
      if (!prev || c.date < prev.date) firstPerRepo.set(c.repo, c);
    }
    const fixes = [...firstPerRepo.values()].sort((a, b) => a.date.localeCompare(b.date));
    const lags = fixes.map((f) => days(inc.changeDate, f.date));
    for (const f of fixes) {
      rows.push({ incident: inc.id, provider: inc.provider, change_date: inc.changeDate, lag_days: days(inc.changeDate, f.date), ...f, message: f.message.split("\n")[0].slice(0, 200) });
    }
    const after = lags.filter((l) => l >= 0);
    const coverage = raw[`${inc.id}#coverage`] ?? {};
    summary.push({
      incident: inc.id,
      provider: inc.provider,
      kind: inc.kind,
      change_date: inc.changeDate,
      search_matches: coverage.search_matches ?? null,
      fetched: coverage.fetched ?? null,
      candidate_commits: cands.length,
      repos_with_matching_fix: fixes.length,
      fixed_before_date: lags.filter((l) => l < 0).length,
      fixed_within_7_days: after.filter((l) => l <= 7).length,
      fixed_after_30_days: after.filter((l) => l > 30).length,
      median_lag_days_after_change: median(after),
      p90_lag_days_after_change: pct(after, 90),
      first_fix: fixes[0]?.date ?? null,
    });
    console.error(`${inc.id}: ${fixes.length} repos with a matching fix, median lag ${median(after)} days`);
  }
  return { rows, summary };
}

async function mineProviders() {
  const out = [];
  for (const [id, name] of PROVIDERS) {
    // Raw search volume only: an upper bound on breakage-related commits, not a count of real fixes.
    // (Checking this sample with a rule would be circular: the query already requires the same words.)
    let total = 0;
    const repos = new Set();
    const samples = [];
    for (const t of PROVIDER_TEMPLATES) {
      const data = await search(`${t(name)} committer-date:>=${SINCE_12M}`, 1);
      total += data.total_count;
      for (const item of data.items.filter(keep)) {
        repos.add(item.repository.full_name);
        if (samples.length < 10) samples.push(`${item.repository.full_name}: ${item.commit.message.split("\n")[0].slice(0, 120)}`);
      }
    }
    out.push({ provider: id, name, raw_matches_12m: total, distinct_repos_first_page: repos.size, samples });
    console.error(`${name}: ${total} raw matches`);
  }
  return out.sort((a, b) => b.raw_matches_12m - a.raw_matches_12m);
}

const raw = FROM_RAW ? JSON.parse(readFileSync(FROM_RAW, "utf8")) : await collectIncidentCandidates();
if (RAW_OUT && !FROM_RAW) writeFileSync(RAW_OUT, JSON.stringify(raw, null, 1) + "\n");
const incidents = classifyIncidents(raw);
const providers = SKIP_PROVIDERS ? undefined : await mineProviders();

mkdirSync(OUT, { recursive: true });
writeFileSync(
  path.join(OUT, "commit-mining-incidents.csv"),
  csv(incidents.rows, ["incident", "provider", "change_date", "lag_days", "date", "repo", "sha", "url", "message"]),
);
if (providers) {
  writeFileSync(
    path.join(OUT, "commit-mining-providers.csv"),
    csv(providers, ["provider", "name", "raw_matches_12m", "distinct_repos_first_page"]),
  );
}
const summaryFile = path.join(OUT, "commit-mining-summary.json");
let previous = {};
try {
  previous = JSON.parse(readFileSync(summaryFile, "utf8"));
} catch {
  // first run
}
writeFileSync(
  summaryFile,
  JSON.stringify({ generated: TODAY, since12m: SINCE_12M, incidents: incidents.summary, providers: providers ?? previous.providers ?? null }, null, 2) + "\n",
);
console.error(`wrote ${OUT}`);
