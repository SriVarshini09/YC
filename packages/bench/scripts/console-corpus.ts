/**
 * The provider console's public corpus (execution plan PC-01): for each provider with an npm SDK, up to PER_PROVIDER
 * public, non-fork GitHub repositories whose package.json declares that SDK, found with GitHub code search and frozen
 * at their default branch's commit in datasets/console-corpus.json, so the console can be rebuilt from the same code.
 *
 *   pnpm --filter @shapi/bench bench:console-corpus
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { githubToken } from "./github.ts";

const PER_PROVIDER = 25;
/** Repositories larger than this (GitHub's size, KB) are passed over: the console scans source, not vendored assets. */
const MAX_KB = 40_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const providers = JSON.parse(readFileSync(path.join(benchRoot, "..", "core", "providers.json"), "utf8")) as { id: string; sdkPackages: string[] }[];
const token = githubToken();
if (!token) throw new Error("needs a GitHub token (GITHUB_TOKEN or gh auth login)");
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "shapi-bench" };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return (await res.json()) as T;
    // Code search allows 10 requests a minute: wait out a limit and try again.
    if ((res.status === 403 || res.status === 429) && attempt < 5) {
      await pause(65_000);
      continue;
    }
    throw new Error(`GET ${url}: ${res.status}`);
  }
}

const corpus: { repo: string; sha: string; provider: string; package: string }[] = [];
const seen = new Set<string>();
for (const p of providers) {
  let found = 0;
  for (const pkg of p.sdkPackages) {
    if (found >= PER_PROVIDER) break;
    const q = encodeURIComponent(`"\\"${pkg}\\":" filename:package.json`);
    const search = await get<{ items: { repository: { full_name: string; fork: boolean } }[] }>(`https://api.github.com/search/code?q=${q}&per_page=100`);
    await pause(6_500);
    for (const item of search.items) {
      if (found >= PER_PROVIDER) break;
      const name = item.repository.full_name;
      if (item.repository.fork || seen.has(name)) continue;
      seen.add(name);
      const repo = await get<{ size: number; default_branch: string; archived: boolean; private: boolean }>(`https://api.github.com/repos/${name}`);
      if (repo.private || repo.size > MAX_KB) continue;
      const commit = await get<{ sha: string }>(`https://api.github.com/repos/${name}/commits/${encodeURIComponent(repo.default_branch)}`);
      corpus.push({ repo: name, sha: commit.sha, provider: p.id, package: pkg });
      found++;
    }
  }
  console.log(`${p.id}: ${found} repositories`);
}
writeFileSync(
  path.join(benchRoot, "datasets", "console-corpus.json"),
  `${JSON.stringify({ name: "SHAPI provider console corpus", builtAt: new Date().toISOString().slice(0, 10), perProvider: PER_PROVIDER, repos: corpus }, null, 2)}\n`,
);
console.log(`${corpus.length} repositories`);
