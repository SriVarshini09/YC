import { readFileSync } from "node:fs";
import { defineLoader } from "vitepress";

// Build-time data from the provider console (execution plan PC-01), packages/bench/results/provider-console.json.

export interface ConsoleData {
  k: number;
  repos: number;
  corpus: { datasets: string[]; repos: number; scanned: number; failed: number };
  providers: { provider: string; repos: number; endpointsBelowK: number; endpoints: { operation: string; repos: number }[] }[];
  providersBelowK: number;
}

declare const data: ConsoleData;
export { data };

export default defineLoader({
  watch: ["../../packages/bench/results/provider-console.json"],
  load([file]: string[]): ConsoleData {
    return JSON.parse(readFileSync(file!, "utf8")) as ConsoleData;
  },
});
