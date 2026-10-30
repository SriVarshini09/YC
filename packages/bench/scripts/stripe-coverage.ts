/**
 * Advisory coverage of Stripe's breaking changes (execution plan C-05): every GA "Breaking" row of Dahlia and Endive's
 * first version that touches a Stripe method in providers.json needs an advisory citing it, or an exemption in
 * datasets/stripe-coverage-exemptions.json. Prints each row and exits 1 on a gap. Reads docs.stripe.com, cached under
 * .cache/spec-replay (shared with the spec replay).
 *
 *   pnpm --filter @shapi/bench bench:stripe-coverage
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadAdvisories } from "@shapi/core";
import { parseEntryChanges, parseReleasePage, previewOnly, stripeCoverage, type ChangelogEntry } from "@shapi/bench";

const RELEASES = [
  { release: "dahlia", day: "2026-03-25" },
  { release: "endive", day: "2026-09-30" },
];
const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const repoRoot = path.resolve(benchRoot, "..", "..");
const cache = path.join(benchRoot, ".cache", "spec-replay");
mkdirSync(cache, { recursive: true });

async function cached(name: string, url: string): Promise<string> {
  const file = path.join(cache, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  const res = await fetch(url, { headers: { "user-agent": "shapi-bench" } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

const releases = [];
for (const r of RELEASES) {
  const page = await cached(`${r.release}.md`, `https://docs.stripe.com/changelog/${r.release}.md`);
  const entries: ChangelogEntry[] = [];
  for (const e of parseReleasePage(page).filter((x) => x.date === r.day)) {
    const md = await cached(`${r.release}-${e.url.split("/").pop()}`, e.url);
    entries.push({ ...e, rest: parseEntryChanges(md), preview: previewOnly(md) });
  }
  releases.push({ release: r.release, entries });
}
const { rows, gaps } = stripeCoverage({
  releases,
  advisories: loadAdvisories(path.join(repoRoot, "advisories")),
  sdkMethods: getProvider("stripe")!.sdkMethods ?? {},
  exemptions: JSON.parse(readFileSync(path.join(benchRoot, "datasets", "stripe-coverage-exemptions.json"), "utf8")) as Record<string, string>,
});
for (const r of rows) {
  const status = r.advisories.length ? `covered by ${r.advisories.join(", ")}` : r.exempt ? `exempt: ${r.exempt}` : "GAP: no advisory cites it";
  console.log(`${r.release}  ${r.title}\n  touches ${r.methods.join(", ")}\n  ${status}`);
}
writeFileSync(path.join(benchRoot, "results", "stripe-coverage.json"), `${JSON.stringify({ rows, gaps: gaps.length }, null, 2)}\n`);
console.log(`${rows.length} breaking entries touch a mapped Stripe method; ${gaps.length} gaps`);
process.exit(gaps.length ? 1 : 0);
