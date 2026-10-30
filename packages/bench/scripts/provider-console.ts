/**
 * Provider console v0 (execution plan PC-01): public open-source repositories, the benchmark's (APIBreak-Replay, at
 * their latest fix commit) and the console corpus (datasets/console-corpus.json, built by bench:console-corpus), each
 * scanned once and aggregated per provider with a k≥5 repository threshold. Customers' repositories are not part of
 * this report.
 *
 *   pnpm --filter @shapi/bench bench:console -- [--cache .cache]
 *
 * Writes results/provider-console.json, which shapi.dev/console shows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApiLock, type ApiLock } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { CONSOLE_K, providerConsole, withRepoAt, type Dataset } from "@shapi/bench";
import { githubToken } from "./github.ts";

const { values } = parseArgs({ options: { cache: { type: "string", default: ".cache" } } });
const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const dataset = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "apibreak-v0.json"), "utf8")) as Dataset;
const token = githubToken();
await loadPythonParser();

// One scan per repository: the benchmark's at its latest fix commit, the corpus's at the commit it was frozen at.
const latest = new Map<string, { sha: string; date: string }>();
for (const i of dataset.instances) if (!latest.has(i.repo) || latest.get(i.repo)!.date < i.fixDate) latest.set(i.repo, { sha: i.fixCommit, date: i.fixDate });
const corpus = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "console-corpus.json"), "utf8")) as { name: string; builtAt: string; repos: { repo: string; sha: string }[] };
for (const r of corpus.repos) if (!latest.has(r.repo)) latest.set(r.repo, { sha: r.sha, date: corpus.builtAt });

// Eight downloads at a time. Only the benchmark's archives are cached (bench:run reuses them); the corpus's are not kept.
const benchmarkRepos = new Set(dataset.instances.map((i) => i.repo));
const locks: ApiLock[] = [];
const failed: string[] = [];
const queue = [...latest].sort(([a], [b]) => a.localeCompare(b));
let done = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [repo, { sha }] = next;
      const cacheDir = benchmarkRepos.has(repo) ? path.resolve(benchRoot, values.cache!) : undefined;
      try {
        locks.push(await withRepoAt({ repo, sha, token, cacheDir, mirror: benchmarkRepos.has(repo) }, (root) => createApiLock(extractCallSites(root), "shapi-bench")));
      } catch (err) {
        failed.push(repo);
        console.log(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (++done % 50 === 0) console.log(`${done} / ${latest.size}`);
    }
  }),
);

const report = providerConsole(locks, CONSOLE_K);
const result = { corpus: { datasets: [`${dataset.name} ${dataset.version}`, `${corpus.name} (${corpus.builtAt})`], repos: latest.size, scanned: locks.length, failed: failed.length }, ...report };
writeFileSync(path.join(benchRoot, "results", "provider-console.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`${locks.length} of ${latest.size} repositories scanned; ${report.providers.length} providers with at least ${CONSOLE_K} repositories, ${report.providersBelowK} below`);
for (const p of report.providers) console.log(`${p.provider}: ${p.repos} repos, ${p.endpoints.length} endpoints listed, ${p.endpointsBelowK} below k`);
