/**
 * Spec churn index (execution plan P-17): every spec in the APIs.guru openapi-directory, each version diffed against
 * the one before it, and providers ranked by how often a new version breaks a client. Needs a clone of the directory
 * (no checkout; about 650 MB):
 *
 *   git clone --no-checkout --single-branch https://github.com/APIs-guru/openapi-directory.git packages/bench/.cache/apis-guru
 *   pnpm --filter @shapi/bench bench:spec-churn
 *
 * About 100,000 spec edits: the files are split across one process per core (each file's versions stay in one
 * process, in order). Writes results/spec-churn.json, which shapi.dev/guide/spec-churn shows.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { breakingChanges, churnIndex, normalizeSpec, parseRawLog, type SpecEdit, type VersionPair } from "@shapi/bench";

const MIN_PAIRS = 10;
/** Larger specs (a few cloud providers' giants) are counted as skipped. */
const MAX_BYTES = 3_000_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const work = path.join(benchRoot, ".cache", "spec-churn");
const shardArg = process.argv.indexOf("--shard");

interface ShardResult {
  pairs: VersionPair[];
  skipped: { tooLarge: number; unreadable: number };
}

if (shardArg > 0) {
  // A child: diff every version of the files in its shard.
  const [repo, shardFile, outFile] = process.argv.slice(shardArg + 1) as [string, string, string];
  const edits = JSON.parse(readFileSync(shardFile, "utf8")) as SpecEdit[];
  writeFileSync(outFile, JSON.stringify(await diffShard(repo, edits)));
} else {
  const repo = process.argv[2] ?? path.join(benchRoot, ".cache", "apis-guru");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  const head = git("rev-parse", "HEAD").trim();
  const headDate = git("show", "-s", "--format=%cI", head).trim();
  const edits = parseRawLog(git("log", "--raw", "--no-abbrev", "--no-renames", "--format=@%H %cI", "--", "APIs"));
  console.log(`${edits.length} spec edits up to ${head.slice(0, 12)} (${headDate})`);

  // Files to shards, largest first onto the lightest shard.
  const byFile = new Map<string, SpecEdit[]>();
  for (const e of edits) byFile.set(e.path, [...(byFile.get(e.path) ?? []), e]);
  const n = Math.max(1, Math.min(16, os.availableParallelism() - 2));
  const shards: SpecEdit[][] = Array.from({ length: n }, () => []);
  for (const list of [...byFile.values()].sort((a, b) => b.length - a.length)) shards.sort((a, b) => a.length - b.length)[0]!.push(...list);
  mkdirSync(work, { recursive: true });
  const started = Date.now();
  const results = await Promise.all(
    shards.map(
      (shard, i) =>
        new Promise<ShardResult>((resolve, reject) => {
          const [inFile, outFile] = [path.join(work, `shard-${i}.json`), path.join(work, `result-${i}.json`)];
          writeFileSync(inFile, JSON.stringify(shard));
          const child = spawn(process.execPath, [path.join(benchRoot, "..", "..", "scripts", "run-ts.mjs"), fileURLToPath(import.meta.url), "--shard", repo, inFile, outFile], { stdio: ["ignore", "inherit", "inherit"] });
          child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(readFileSync(outFile, "utf8")) as ShardResult) : reject(new Error(`shard ${i} exited ${code}`))));
        }),
    ),
  );
  const pairs = results.flatMap((r) => r.pairs);
  const skipped = { tooLarge: results.reduce((s, r) => s + r.skipped.tooLarge, 0), unreadable: results.reduce((s, r) => s + r.skipped.unreadable, 0) };
  const providers = churnIndex(pairs, MIN_PAIRS);
  const result = {
    directory: { repo: "https://github.com/APIs-guru/openapi-directory", commit: head, committedAt: headDate, license: "CC0-1.0" },
    minPairs: MIN_PAIRS,
    maxBytes: MAX_BYTES,
    totals: { edits: edits.length, specs: byFile.size, pairs: pairs.length, breakingPairs: pairs.filter((p) => p.breaking > 0).length, skipped },
    providers,
  };
  writeFileSync(path.join(benchRoot, "results", "spec-churn.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${pairs.length} version pairs, ${result.totals.breakingPairs} breaking, in ${Math.round((Date.now() - started) / 60000)} min; ${providers.length} providers with at least ${MIN_PAIRS}; skipped ${JSON.stringify(skipped)}`);
  for (const p of providers.slice(0, 25)) console.log(`${p.provider.padEnd(32)} ${String(p.breakingPairs).padStart(5)} / ${String(p.pairs).padEnd(5)} ${(p.rate.rate * 100).toFixed(1)}% [${(p.rate.low * 100).toFixed(1)}–${(p.rate.high * 100).toFixed(1)}]`);
}

/** Diff each edit's spec against the version before it, reading blobs through one `git cat-file --batch`. */
async function diffShard(repo: string, edits: SpecEdit[]): Promise<ShardResult> {
  const cat = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  const waiting: ((b: Buffer | undefined) => void)[] = [];
  let want: number | undefined;
  cat.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (want === undefined) {
        const nl = buffer.indexOf(10);
        if (nl < 0) return;
        const size = /^[0-9a-f]{40} blob (\d+)$/.exec(buffer.subarray(0, nl).toString())?.[1];
        buffer = buffer.subarray(nl + 1);
        if (size === undefined) {
          waiting.shift()!(undefined);
          continue;
        }
        want = Number(size);
      }
      if (buffer.length < want + 1) return;
      const body = buffer.subarray(0, want);
      buffer = buffer.subarray(want + 1);
      want = undefined;
      waiting.shift()!(body);
    }
  });
  const readBlob = (id: string) =>
    new Promise<Buffer | undefined>((resolve) => {
      waiting.push(resolve);
      cat.stdin.write(`${id}\n`);
    });

  const skipped = { tooLarge: 0, unreadable: 0 };
  const cache = new Map<string, ReturnType<typeof normalizeSpec> | null>();
  const spec = async (id: string, file: string) => {
    if (cache.has(id)) return cache.get(id) ?? undefined;
    const body = await readBlob(id);
    let parsed: ReturnType<typeof normalizeSpec> | null = null;
    if (!body) skipped.unreadable++;
    else if (body.length > MAX_BYTES) skipped.tooLarge++;
    else {
      try {
        const text = body.toString("utf8");
        parsed = normalizeSpec(file.endsWith(".json") ? JSON.parse(text) : load(text, { json: true })) ?? null;
        if (!parsed) skipped.unreadable++;
      } catch {
        skipped.unreadable++;
      }
    }
    // Each file's versions are diffed in order, so only the latest couple of blobs is needed again.
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    cache.set(id, parsed);
    return parsed ?? undefined;
  };

  const pairs: VersionPair[] = [];
  for (const e of edits) {
    const [before, after] = [await spec(e.before, e.path), await spec(e.after, e.path)];
    if (!before || !after) continue;
    try {
      pairs.push({ path: e.path, commit: e.commit, date: e.date, breaking: breakingChanges(before, after).length });
    } catch {
      skipped.unreadable++;
    }
  }
  cat.stdin.end();
  return { pairs, skipped };
}
