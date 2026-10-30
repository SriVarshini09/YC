/**
 * Spec-history replay for OpenAI (execution plan P-10). For each entry on OpenAI's deprecations page announced since
 * openai/openai-openapi started publishing openapi.json, diff the last spec before the announcement against the current
 * one, and score which deprecated models and endpoints the diff shows. Writes results/spec-replay/openai/replay.json
 * and the OpenAI table in SPEC-REPLAY.md. Read only: public GitHub and developers.openai.com pages, cached under
 * .cache/spec-replay.
 *
 *   pnpm --filter @shapi/bench bench:spec-replay:openai
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorySchema } from "@shapi/core";
import { diffSpecs, draftAdvisory, operationsReturning, parseOpenAiDeprecations, scoreOpenAiReplay } from "@shapi/bench";
import { githubToken } from "./github.ts";

const REPO = "openai/openai-openapi";
const SPEC = "openapi.json";
const PAGE = "https://developers.openai.com/api/docs/deprecations.md";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const cache = path.join(benchRoot, ".cache", "spec-replay");
const outDir = path.join(benchRoot, "results", "spec-replay", "openai");
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });
const token = githubToken();
const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(token ? { authorization: `Bearer ${token}` } : {}) };

async function cached(name: string, url: string): Promise<string> {
  const file = path.join(cache, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": "shapi-bench" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

/** Every commit that changed openapi.json, oldest first. */
const commits: { sha: string; date: string }[] = [];
for (let page = 1; ; page++) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${SPEC}&per_page=100&page=${page}`, { headers: ghHeaders });
  if (!res.ok) throw new Error(`commits: ${res.status}`);
  const batch = (await res.json()) as { sha: string; commit: { committer: { date: string } } }[];
  commits.push(...batch.map((c) => ({ sha: c.sha, date: c.commit.committer.date })));
  if (batch.length < 100) break;
}
commits.sort((a, b) => a.date.localeCompare(b.date));
const first = commits[0]!;
const latest = commits.at(-1)!;
const specAt = async (sha: string) => JSON.parse(await cached(`openai-${sha}.json`, `https://raw.githubusercontent.com/${REPO}/${sha}/${SPEC}`));

const day = new Date().toISOString().slice(0, 10);
const page = await cached(`openai-deprecations-${day}.md`, PAGE);
// Entries announced after the first published openapi.json, so a spec from before the announcement exists.
const entries = parseOpenAiDeprecations(page).filter((e) => e.date > first.date.slice(0, 10) && e.rows.length);
const after = await specAt(latest.sha);
const scored = [];
const drafts = [];
for (const entry of entries) {
  const before = commits.filter((c) => c.date.slice(0, 10) < entry.date).at(-1)!;
  const changes = diffSpecs(await specAt(before.sha), after, { deprecations: true });
  scored.push({ entry, before: before.sha, changes });
  console.log(`${entry.date} ${entry.title}: ${entry.rows.length} rows; spec ${before.sha.slice(0, 7)} → ${latest.sha.slice(0, 7)}, ${changes.length} changes`);
}
const afterText = JSON.stringify(after);
const score = scoreOpenAiReplay({ entries: scored, listed: (name) => afterText.includes(`"${name}"`) });
// Drafts from the widest diff (the earliest announcement's): the others are subsets of it.
if (scored.length) {
  const widest = scored.reduce((a, b) => (a.changes.length >= b.changes.length ? a : b));
  const returning = operationsReturning(await specAt(widest.before));
  const sources = [`https://github.com/${REPO}/blob/${latest.sha}/${SPEC}`, PAGE.replace(/\.md$/, "")];
  drafts.push(...widest.changes.map((c) => AdvisorySchema.parse(draftAdvisory(c, { provider: "openai", providerName: "OpenAI", version: day, returning, sources }))));
}
writeFileSync(
  path.join(outDir, "replay.json"),
  `${JSON.stringify({ firstSpec: first, latestSpec: latest, score, entries: scored.map((s) => ({ ...s.entry, before: s.before, changes: s.changes.length })), drafts }, null, 2)}\n`,
);

// SPEC-REPLAY.md keeps its prose; the OpenAI table between its markers is regenerated.
const doc = path.join(benchRoot, "SPEC-REPLAY.md");
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
const table = [
  "<!-- openai:start -->",
  `Run on ${day}, against [\`${latest.sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${latest.sha}). \`openapi.json\` is published since ${first.date.slice(0, 10)}. Results: [results/spec-replay/openai/](results/spec-replay/openai/).`,
  "",
  "| Deprecation entries | Rows (models and endpoints) | Shown by the spec diff | Endpoint rows shown | Model rows shown |",
  "|---|---|---|---|---|",
  `| ${score.entries} | ${score.rows} | ${score.shown} (${pct(score.shown, score.rows)}) | ${score.endpointRowsShown} of ${score.endpointRows} | ${score.modelRowsShown} of ${score.modelRows} |`,
  "<!-- openai:end -->",
].join("\n");
const text = readFileSync(doc, "utf8");
if (!text.includes("<!-- openai:start -->")) throw new Error("SPEC-REPLAY.md has no <!-- openai:start --> marker");
writeFileSync(doc, text.replace(/<!-- openai:start -->[\s\S]*<!-- openai:end -->/, table));
console.log(JSON.stringify(score, null, 2));
