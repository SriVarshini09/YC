import { readFileSync } from "node:fs";
import { defineLoader } from "vitepress";

// Build-time data from the fix tier registry (execution plan U-04), packages/core/tiers.json: the same file the
// GitHub App reads when it decides whether a fix PR opens as a draft.

export interface TierCellRow {
  recipe: string;
  provider: string;
  changeClass: string;
  tier: "ALERT" | "REVIEW" | "AUTO";
  passes: string[];
  failures: string[];
  reasons: string[];
}

export interface TierData {
  benchmark: { dataset: string; shapiVersion: string; runAt: string };
  autoAfter: number;
  cells: TierCellRow[];
  counts: Record<"ALERT" | "REVIEW" | "AUTO", number>;
}

declare const data: TierData;
export { data };

export default defineLoader({
  watch: ["../../packages/core/tiers.json"],
  load([file]: string[]): TierData {
    const registry = JSON.parse(readFileSync(file!, "utf8")) as Omit<TierData, "counts">;
    const counts = { ALERT: 0, REVIEW: 0, AUTO: 0 };
    for (const c of registry.cells) counts[c.tier]++;
    return { benchmark: registry.benchmark, autoAfter: registry.autoAfter, cells: registry.cells, counts };
  },
});
