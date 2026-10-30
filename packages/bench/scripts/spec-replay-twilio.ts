/**
 * Spec-history replay for Twilio (execution plan P-10). For each twilio-oai release since 2.1.0 whose CHANGES.md marks
 * a breaking change, diff the named products' specs at its tag against the previous release's, draft unverified
 * advisories, and score the changes against the breaking lines. Writes results/spec-replay/twilio/replay.json and the
 * Twilio table in SPEC-REPLAY.md. Read only: public GitHub pages, cached under .cache/spec-replay.
 *
 *   pnpm --filter @shapi/bench bench:spec-replay:twilio
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdvisorySchema } from "@shapi/core";
import { diffSpecs, draftAdvisory, operationsReturning, parseTwilioChanges, scoreTwilioReplay, twilioSpecFiles, type SpecChange } from "@shapi/bench";
import { githubToken } from "./github.ts";

const REPO = "twilio/twilio-oai";
/** 2.0.0 is the generator's major release: its breaking lines are branch merges that name nothing. */
const SINCE = "2024-09-01";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const cache = path.join(benchRoot, ".cache", "spec-replay");
const outDir = path.join(benchRoot, "results", "spec-replay", "twilio");
mkdirSync(cache, { recursive: true });
mkdirSync(outDir, { recursive: true });
const token = githubToken();
const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(token ? { authorization: `Bearer ${token}` } : {}) };

/** A file from the cache, or fetched; `undefined` for a 404 (a spec added or removed in that release). */
async function cached(name: string, url: string, headers: Record<string, string> = {}): Promise<string | undefined> {
  const file = path.join(cache, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": "shapi-bench", ...headers } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

const EMPTY = { info: { version: "" }, paths: {}, components: { schemas: {} } };
const day = new Date().toISOString().slice(0, 10);
const changesMd = (await cached(`twilio-CHANGES-${day}.md`, `https://raw.githubusercontent.com/${REPO}/main/CHANGES.md`))!;
const all = parseTwilioChanges(changesMd);
const specFilesAt = async (tag: string) =>
  (JSON.parse((await cached(`twilio-files-${tag}.json`, `https://api.github.com/repos/${REPO}/contents/spec/json?ref=${tag}`, ghHeaders))!) as { name: string }[]).map((f) => f.name);
const specAt = async (tag: string, file: string) => {
  const text = await cached(`twilio-${tag}-${file}`, `https://raw.githubusercontent.com/${REPO}/${tag}/spec/json/${file}`);
  return text ? JSON.parse(text) : EMPTY;
};

const releases = [];
const drafts = [];
for (const [i, r] of all.entries()) {
  if (r.date < SINCE || !r.entries.length) continue;
  const previous = all[i + 1]!;
  const specFiles = await specFilesAt(r.version);
  const files = [...new Set(r.entries.flatMap((e) => twilioSpecFiles(e.product, specFiles)))].sort();
  const changes: SpecChange[] = [];
  for (const file of files) {
    const [before, after] = [await specAt(previous.version, file), await specAt(r.version, file)];
    const found = diffSpecs(before, after).map((c) => ({ ...c, file }));
    changes.push(...found);
    const returning = operationsReturning(before);
    const sources = [`https://github.com/${REPO}/blob/${r.version}/spec/json/${file}`, `https://github.com/${REPO}/blob/main/CHANGES.md`];
    drafts.push(...found.map((c) => AdvisorySchema.parse(draftAdvisory(c, { provider: "twilio", providerName: "Twilio", version: r.date, returning, sources }))));
  }
  releases.push({ version: r.version, previous: previous.version, date: r.date, files, changes, entries: r.entries, specFiles });
  console.log(`${previous.version} → ${r.version}: ${files.join(", ") || "no spec files"}; ${changes.length} changes for ${r.entries.length} breaking lines`);
}

const score = scoreTwilioReplay({ releases });
writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify({ score, releases: releases.map((r) => ({ version: r.version, previous: r.previous, date: r.date, files: r.files, entries: r.entries, changes: r.changes })), drafts }, null, 2)}\n`);

// SPEC-REPLAY.md keeps its prose; the Twilio table between its markers is regenerated.
const doc = path.join(benchRoot, "SPEC-REPLAY.md");
const pct = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
const scorable = score.breakingEntries - score.outsideSpec - score.namesNothing;
const table = [
  "<!-- twilio:start -->",
  `Run on ${day}. Results: [results/spec-replay/twilio/](results/spec-replay/twilio/).`,
  "",
  "| Releases | Breaking lines | Found in the spec diff | No spec for the product | Names nothing | Found, of those a spec can show | Spec changes found / matching a breaking line |",
  "|---|---|---|---|---|---|---|",
  `| ${score.releases.length} (${score.releases.at(-1)?.version} to ${score.releases[0]?.version}) | ${score.breakingEntries} | ${score.found} (${pct(score.found, score.breakingEntries)}) | ${score.outsideSpec} | ${score.namesNothing} | ${score.found} of ${scorable} (${pct(score.found, scorable)}) | ${score.candidates} / ${score.candidatesMatching} |`,
  "<!-- twilio:end -->",
].join("\n");
const text = readFileSync(doc, "utf8");
if (!text.includes("<!-- twilio:start -->")) throw new Error("SPEC-REPLAY.md has no <!-- twilio:start --> marker");
writeFileSync(doc, text.replace(/<!-- twilio:start -->[\s\S]*<!-- twilio:end -->/, table));
console.log(JSON.stringify(score, null, 2));
