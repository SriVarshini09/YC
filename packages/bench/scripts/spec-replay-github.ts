/**
 * Spec-history replay for GitHub (execution plan P-09). github/rest-api-description publishes a description per REST
 * API version side by side: diff the previous version's against the new one's at the same commit, draft unverified
 * advisories from what changed, and score the changes against the new version's section of GitHub's breaking-changes
 * page. Also records what GET /versions answers. Writes results/spec-replay/github/<version>.json and the GitHub table
 * in SPEC-REPLAY.md. Read only: public GitHub and docs.github.com pages, cached under .cache/spec-replay.
 *
 *   pnpm --filter @shapi/bench bench:spec-replay:github
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorySchema } from "@shapi/core";
import { diffSpecs, draftAdvisory, operationsReturning, parseGithubBreakingChanges, scoreGithubReplay } from "@shapi/bench";
import { githubToken } from "./github.ts";

const VERSION = "2026-03-10";
const PREVIOUS = "2022-11-28";
const REPO = "github/rest-api-description";
const DIR = "descriptions/api.github.com";
const BREAKING_PAGE = "https://docs.github.com/en/rest/about-the-rest-api/breaking-changes";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const cache = path.join(benchRoot, ".cache", "spec-replay");
const outDir = path.join(benchRoot, "results", "spec-replay", "github");
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });
const token = githubToken();
const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(token ? { authorization: `Bearer ${token}` } : {}) };

async function cached(name: string, url: string, headers: Record<string, string> = {}): Promise<string> {
  const file = path.join(cache, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": "shapi-bench", ...headers } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

// The newest commit that changed the descriptions: both versions are read from it.
const commits = await fetch(`https://api.github.com/repos/${REPO}/commits?path=${DIR}&per_page=1`, { headers: ghHeaders });
if (!commits.ok) throw new Error(`commits: ${commits.status}`);
const commit = ((await commits.json()) as { sha: string }[])[0]!.sha;
const specAt = async (version: string) =>
  JSON.parse(await cached(`github-${commit}-${version}.json`, `https://raw.githubusercontent.com/${REPO}/${commit}/${DIR}/api.github.com.${version}.json`));
const [before, after] = [await specAt(PREVIOUS), await specAt(VERSION)];
const changes = diffSpecs(before, after, { statusAdded: true });

// The page's markdown body, through docs.github.com's article API.
const day = new Date().toISOString().slice(0, 10);
const page = await cached(`github-breaking-changes-${day}.md`, `https://docs.github.com/api/article/body?pathname=${new URL(BREAKING_PAGE).pathname}`);
const entries = parseGithubBreakingChanges(page, VERSION);
const versions = (await (await fetch("https://api.github.com/versions", { headers: ghHeaders })).json()) as string[];

const returning = operationsReturning(before);
const score = scoreGithubReplay({ version: VERSION, previous: PREVIOUS, commit, changes, entries, returning, supportedVersions: versions });
const sources = [`https://github.com/${REPO}/blob/${commit}/${DIR}/api.github.com.${VERSION}.json`, `${BREAKING_PAGE}?apiVersion=${VERSION}`];
const drafts = changes.map((c) => AdvisorySchema.parse(draftAdvisory(c, { provider: "github", providerName: "GitHub", version: VERSION, returning, sources })));
writeFileSync(path.join(outDir, `${VERSION}.json`), `${JSON.stringify({ score, entries, changes, drafts }, null, 2)}\n`);
console.log(`github ${PREVIOUS} → ${VERSION} at ${commit.slice(0, 7)}: ${changes.length} changes; ${score.found}/${score.breakingEntries} breaking entries found, ${score.behaviorOnly} behavior-only`);

// SPEC-REPLAY.md keeps its prose; the GitHub table between its markers is regenerated.
const doc = path.join(benchRoot, "SPEC-REPLAY.md");
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
const scorable = score.breakingEntries - score.behaviorOnly;
const table = [
  "<!-- github:start -->",
  `Run on ${day}. Results: [results/spec-replay/github/](results/spec-replay/github/). \`GET /versions\` answered ${versions.map((v) => `\`${v}\``).join(", ")}.`,
  "",
  "| Versions | Spec commit | Spec changes found | Breaking entries | Found in the spec diff | Behavior only | Found, of those a spec can show | Changes matching a listed break / none |",
  "|---|---|---|---|---|---|---|---|",
  `| \`${PREVIOUS}\` → \`${VERSION}\` | [\`${commit.slice(0, 7)}\`](https://github.com/${REPO}/tree/${commit}/${DIR}) | ${score.candidates} | ${score.breakingEntries} | ${score.found} (${pct(score.found, score.breakingEntries)}) | ${score.behaviorOnly} | ${score.found} of ${scorable} (${pct(score.found, scorable)}) | ${score.candidatesMatching} / ${score.candidatesUnlisted} |`,
  "<!-- github:end -->",
].join("\n");
const text = readFileSync(doc, "utf8");
if (!text.includes("<!-- github:start -->")) throw new Error("SPEC-REPLAY.md has no <!-- github:start --> marker");
writeFileSync(doc, text.replace(/<!-- github:start -->[\s\S]*<!-- github:end -->/, table));
console.log(JSON.stringify({ ...score, missed: score.missed }, null, 2));
