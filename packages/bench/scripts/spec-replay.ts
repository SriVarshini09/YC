/**
 * Spec-history replay for Stripe (execution plan P-08). For each breaking release, find the last commit of
 * stripe/openapi's spec3.json on the previous version and the first on the new one, diff the two specs, draft
 * unverified advisories from what changed, and score the changes against the release's changelog: recall against its
 * GA "Breaking" rows, false positives against its "Non-breaking" rows, and the breaking rows no spec diff can show.
 * Writes results/spec-replay/stripe/<release>.json and the table in SPEC-REPLAY.md. Read only: public GitHub and
 * docs.stripe.com pages, cached under .cache/spec-replay.
 *
 *   pnpm --filter @shapi/bench bench:spec-replay
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorySchema } from "@shapi/core";
import { diffSpecs, draftAdvisory, operationsReturning, parseEntryChanges, parseReleasePage, previewOnly, scoreRelease, type ChangelogEntry, type ReleaseScore } from "@shapi/bench";
import { githubToken } from "./github.ts";

const RELEASES = [
  { release: "basil", version: "2025-03-31.basil" },
  { release: "clover", version: "2025-09-30.clover" },
  { release: "dahlia", version: "2026-03-25.dahlia" },
  { release: "endive", version: "2026-09-30.endive" },
];
const REPO = "stripe/openapi";
const SPEC = "openapi/spec3.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const cache = path.join(benchRoot, ".cache", "spec-replay");
const outDir = path.join(benchRoot, "results", "spec-replay", "stripe");
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });
const token = githubToken();
const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(token ? { authorization: `Bearer ${token}` } : {}) };

async function cached(name: string, url: string, headers: Record<string, string> = {}): Promise<string> {
  const file = path.join(cache, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": "shapi-bench", ...headers } });
    if (res.ok) {
      const text = await res.text();
      writeFileSync(file, text);
      return text;
    }
    if (attempt >= 2 || res.status < 500) throw new Error(`GET ${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

/** Every commit that changed the spec since the first release measured, oldest first. */
async function specCommits(): Promise<{ sha: string; date: string }[]> {
  const out: { sha: string; date: string }[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${SPEC}&since=2024-12-01T00:00:00Z&per_page=100&page=${page}`, { headers: ghHeaders });
    if (!res.ok) throw new Error(`commits: ${res.status}`);
    const batch = (await res.json()) as { sha: string; commit: { committer: { date: string } } }[];
    out.push(...batch.map((c) => ({ sha: c.sha, date: c.commit.committer.date })));
    if (batch.length < 100) break;
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const specAt = async (sha: string) => JSON.parse(await cached(`${sha}.json`, `https://raw.githubusercontent.com/${REPO}/${sha}/${SPEC}`));
const versionAt = async (sha: string) => (await specAt(sha)).info.version as string;

const commits = await specCommits();
console.log(`${commits.length} commits of ${SPEC} since 2024-12-01`);
const scores: ReleaseScore[] = [];
for (const r of RELEASES) {
  // The first commit on the new version: versions start with their date, so they sort by it.
  let lo = 0;
  let hi = commits.length - 1;
  if ((await versionAt(commits[hi]!.sha)).slice(0, 10) < r.version.slice(0, 10)) {
    console.log(`${r.release}: not in ${REPO} yet`);
    continue;
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await versionAt(commits[mid]!.sha)).slice(0, 10) >= r.version.slice(0, 10)) hi = mid;
    else lo = mid + 1;
  }
  const [b, a] = [commits[lo - 1]!, commits[lo]!];
  const [before, after] = [await specAt(b.sha), await specAt(a.sha)];
  const changes = diffSpecs(before, after);

  const page = await cached(`${r.release}.md`, `https://docs.stripe.com/changelog/${r.release}.md`);
  const rows = parseReleasePage(page).filter((e) => e.date === r.version.slice(0, 10));
  const entries: ChangelogEntry[] = [];
  for (const e of rows) {
    const name = `${r.release}-${e.url.split("/").pop()}`;
    const md = await cached(name, e.url);
    entries.push({ ...e, rest: parseEntryChanges(md), preview: previewOnly(md) });
  }
  const score = scoreRelease({ release: r.release, version: r.version, before: { sha: b.sha, version: before.info.version }, after: { sha: a.sha, version: after.info.version }, changes, entries });
  scores.push(score);

  const returning = operationsReturning(before);
  const sources = [`https://github.com/${REPO}/blob/${a.sha}/${SPEC}`, `https://github.com/${REPO}/blob/${b.sha}/${SPEC}`];
  const drafts = changes.map((c) => AdvisorySchema.parse(draftAdvisory(c, { provider: "stripe", version: r.version, returning, sources })));
  writeFileSync(path.join(outDir, `${r.release}.json`), `${JSON.stringify({ score, changes, drafts }, null, 2)}\n`);
  console.log(`${r.release}: ${changes.length} candidates; breaking rows ${score.breakingFound}/${score.breakingEntries} found, ${score.behaviorOnly} behavior-only`);
}

// SPEC-REPLAY.md keeps its prose; the table between the markers is regenerated.
const doc = path.join(benchRoot, "SPEC-REPLAY.md");
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
const rowsMd = scores.map(
  (s) =>
    `| ${s.release} (\`${s.version}\`) | [\`${s.before.sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${s.before.sha}) → [\`${s.after.sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${s.after.sha}) | ${s.candidates} | ${s.breakingEntries} | ${s.breakingFound} (${pct(s.breakingFound, s.breakingEntries)}) | ${s.behaviorOnly} (${pct(s.behaviorOnly, s.breakingEntries)}) | ${s.outsideSpec} | ${s.previewOnly} | ${s.breakingMissed} | ${s.candidatesMatchingBreaking} / ${s.candidatesMatchingNonBreaking} (${s.nonBreakingEntriesMatched} entries) | ${s.clientOnly} |`,
);
const table = [
  "<!-- table:start -->",
  `Run on ${new Date().toISOString().slice(0, 10)}. Results: [results/spec-replay/stripe/](results/spec-replay/stripe/).`,
  "",
  "| Release | Spec commits (before → after) | Spec changes found | GA breaking REST API rows | Found in the spec diff | Behavior only (no field change) | v2 APIs (not in the published spec) | Preview APIs (not in the GA spec) | Field changes the diff missed | Changes matching a breaking / only a non-breaking row | Stripe.js rows (not scored) |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rowsMd,
  "<!-- table:end -->",
].join("\n");
const text = existsSync(doc) ? readFileSync(doc, "utf8") : "# Spec-history replay\n\n<!-- table:start -->\n<!-- table:end -->\n";
writeFileSync(doc, text.replace(/<!-- table:start -->[\s\S]*<!-- table:end -->/, table));
console.log(JSON.stringify(scores.map((s) => ({ ...s, missed: s.missed.length })), null, 2));
