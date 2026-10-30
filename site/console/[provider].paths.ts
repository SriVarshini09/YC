import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// One page per provider in the provider console (execution plan PC-01), from packages/bench/results/provider-console.json.
const file = fileURLToPath(new URL("../../packages/bench/results/provider-console.json", import.meta.url));

interface Count {
  name: string;
  repos: number;
}
interface Report {
  provider: string;
  repos: number;
  endpointsBelowK: number;
  endpoints: { operation: string; repos: number; fields: Count[]; statusCodes: Count[]; headers: Count[]; query: Count[] }[];
}

export default {
  watch: [file],
  paths() {
    const data = JSON.parse(readFileSync(file, "utf8")) as { k: number; repos: number; corpus: { datasets: string[] }; providers: Report[] };
    return data.providers.map((p) => ({ params: { provider: p.provider, report: p, k: data.k, corpusRepos: data.repos, datasets: data.corpus.datasets } }));
  },
};
