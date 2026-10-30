/**
 * Mirror the benchmark in Software Heritage (execution plan P-07): check that it holds every instance's fix commit
 * (its parent, the base commit, comes with it) and record each instance's mirror URL in
 * datasets/<dataset>.mirrors.json, kept apart from the dataset so its hash does not change. With --save it first asks
 * Software Heritage to archive the repositories it does not hold yet ("Save Code Now"); archiving runs on their
 * side and can take hours, so run it again later without --save to record the result.
 *
 *   pnpm --filter @shapi/bench bench:archive -- [--dataset datasets/apibreak-v0.json] [--save]
 *
 * Anonymous use of Software Heritage's API allows 120 requests an hour; the script waits when it runs out.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { mirrorUrl, swhHasCommit, type Dataset } from "@shapi/bench";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { dataset: { type: "string", default: "datasets/apibreak-v0.json" }, save: { type: "boolean", default: false } },
});
const datasetFile = path.resolve(values.dataset);
const dataset = JSON.parse(readFileSync(datasetFile, "utf8")) as Dataset;
const out = datasetFile.replace(/\.json$/, ".mirrors.json");

interface MirrorEntry {
  id: string;
  repo: string;
  fixCommit: string;
  baseCommit: string | null;
  mirror: string;
  archived: boolean;
}
const previous = new Map<string, MirrorEntry>(
  existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { instances: MirrorEntry[] }).instances.map((e) => [e.id, e]) : [],
);

/** Software Heritage's answer, waiting out its rate limit. */
async function swh(url: string, init?: RequestInit): Promise<Response> {
  for (;;) {
    const res = await fetch(url, { ...init, headers: { accept: "application/json", "user-agent": "shapi-bench archive (APIBreak-Replay)" } });
    if (res.status !== 429) return res;
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    const wait = Math.max(60_000, reset - Date.now() + 5_000);
    console.log(`Software Heritage rate limit: waiting ${Math.round(wait / 60_000)} min`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
const limited: typeof fetch = (input, init) => swh(String(input), init);

const entries: MirrorEntry[] = [];
for (const i of dataset.instances) {
  // A commit already found stays found: Software Heritage does not delete what it archived.
  const archived = previous.get(i.id)?.archived || (await swhHasCommit(i.fixCommit, { fetch: limited }));
  entries.push({ id: i.id, repo: i.repo, fixCommit: i.fixCommit, baseCommit: i.baseCommit ?? null, mirror: mirrorUrl(i.repo, i.fixCommit), archived });
  console.log(`${i.id}  ${archived ? "archived" : "not archived yet"}`);
}

if (values.save) {
  const repos = [...new Set(entries.filter((e) => !e.archived).map((e) => e.repo))];
  for (const repo of repos) {
    const res = await swh(`https://archive.softwareheritage.org/api/1/origin/save/git/url/${encodeURIComponent(`https://github.com/${repo}`)}/`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { save_request_status?: string; save_task_status?: string };
    console.log(`save ${repo}: ${res.status} ${body.save_request_status ?? ""} ${body.save_task_status ?? ""}`);
  }
}

writeFileSync(
  out,
  `${JSON.stringify(
    {
      dataset: `${dataset.name} ${dataset.version}`,
      archive: "Software Heritage (https://archive.softwareheritage.org). A commit's SWHID is swh:1:rev:<sha>.",
      checkedAt: new Date().toISOString().slice(0, 10),
      archived: entries.filter((e) => e.archived).length,
      instances: entries,
    },
    null,
    2,
  )}\n`,
);
console.log(`${entries.filter((e) => e.archived).length} / ${entries.length} instances archived; written to ${path.relative(process.cwd(), out)}`);
