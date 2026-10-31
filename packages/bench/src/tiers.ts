import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AUTO_AFTER, cellKey, cellOf, earnTier, type Advisory, type BenchmarkFix, type Demotions, type TierCell, type TierRegistry } from "@shapi/core";
import type { InstanceResult } from "./metrics";

/** A benchmark run as results/<version>/<dataset hash>.json stores it. */
export interface BenchmarkRun {
  dataset: string;
  shapiVersion: string;
  runAt: string;
  results: InstanceResult[];
}

/**
 * The most recent run under results/ that tried fixes (`bench:run --fix`): the newest `runAt` among the per-version
 * folders. A scan-only run (CI's `--check`) has no fix outcomes, so it says nothing about the tiers.
 */
export function latestRun(resultsDir: string): BenchmarkRun {
  const runs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
    .flatMap((d) => readdirSync(path.join(resultsDir, d.name)).filter((f) => f.endsWith(".json")).map((f) => path.join(resultsDir, d.name, f)))
    .map((file) => JSON.parse(readFileSync(file, "utf8")) as BenchmarkRun)
    .filter((run) => run.results.some((r) => r.fixOutcome !== undefined));
  const latest = runs.sort((a, b) => a.runAt.localeCompare(b.runAt)).at(-1);
  if (!latest) throw new Error(`no benchmark run under ${resultsDir}`);
  return latest;
}

/**
 * The fix tier registry (execution plan U-04): every cell an advisory's fix falls in, with the benchmark instances
 * whose fix was tried in it, the founder's demotion, and the tier they earn. An instance counts toward the cell of
 * the method that fixed it (Claude or the recipe); one whose fix found nothing to fix counts toward its advisory's cell.
 */
export function buildTierRegistry(input: { run: BenchmarkRun; advisories: Advisory[]; demotions: Demotions }): TierRegistry {
  const byId = new Map(input.advisories.map((a) => [a.id, a]));
  const cells = new Map<string, { cell: TierCell; benchmark: BenchmarkFix[] }>();
  const cellFor = (cell: TierCell) => cells.get(cellKey(cell)) ?? (cells.set(cellKey(cell), { cell, benchmark: [] }).get(cellKey(cell)) as { cell: TierCell; benchmark: BenchmarkFix[] });
  for (const a of input.advisories) if (a.status === "verified") cellFor(cellOf(a));
  for (const r of input.run.results) {
    const advisory = r.advisoryId ? byId.get(r.advisoryId) : undefined;
    if (!advisory || !r.fixOutcome) continue;
    cellFor(cellOf(advisory, r.fixMethod)).benchmark.push({ id: r.id, outcome: r.fixOutcome, ...(r.fixOutOfScope ? { outOfScope: r.fixOutOfScope } : {}) });
  }
  for (const key of Object.keys(input.demotions)) {
    const [recipe, provider, changeClass] = key.split("/");
    const known = input.advisories.find((a) => a.provider === provider && a.changeClass === changeClass);
    if (!recipe || !known) throw new Error(`tier demotion ${key}: no advisory has provider ${provider} and change class ${changeClass}`);
    cellFor({ recipe, provider: known.provider, changeClass: known.changeClass });
  }
  return {
    benchmark: { dataset: input.run.dataset, shapiVersion: input.run.shapiVersion, runAt: input.run.runAt },
    autoAfter: AUTO_AFTER,
    cells: [...cells.values()]
      .sort((a, b) => cellKey(a.cell).localeCompare(cellKey(b.cell)))
      .map(({ cell, benchmark }) => {
        const demotion = input.demotions[cellKey(cell)];
        return { ...cell, benchmark, ...(demotion ? { demotion } : {}), ...earnTier(cell, { benchmark, ...(demotion ? { demotion } : {}) }) };
      }),
  };
}
