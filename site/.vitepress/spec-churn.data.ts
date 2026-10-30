import { readFileSync } from "node:fs";
import { defineLoader } from "vitepress";

// Build-time data from the spec churn index (execution plan P-17), packages/bench/results/spec-churn.json, written by
// `pnpm --filter @shapi/bench bench:spec-churn` from a clone of the APIs.guru openapi-directory.

interface Rate {
  k: number;
  n: number;
  rate: number;
  low: number;
  high: number;
}

export interface ChurnRow {
  provider: string;
  apis: number;
  pairs: number;
  breakingPairs: number;
  breakingChanges: number;
  rate: Rate;
  first: string;
  last: string;
}

export interface ChurnData {
  directory: { repo: string; commit: string; committedAt: string; license: string };
  minPairs: number;
  maxBytes: number;
  totals: { edits: number; specs: number; pairs: number; breakingPairs: number; skipped: { tooLarge: number; unreadable: number } };
  providers: ChurnRow[];
}

declare const data: ChurnData;
export { data };

export default defineLoader({
  watch: ["../../packages/bench/results/spec-churn.json"],
  load([file]: string[]): ChurnData {
    return JSON.parse(readFileSync(file!, "utf8")) as ChurnData;
  },
});
