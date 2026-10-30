/**
 * Advisory coverage of Shopify's breaking changes (execution plan C-06): every shopify.dev changelog entry tagged
 * "Breaking API Change" since 2026-01 that touches the Admin GraphQL or REST API needs an advisory citing it, or an
 * exemption in datasets/shopify-coverage-exemptions.json. Prints each entry and exits 1 on a gap. Reads the public
 * changelog feed, cached per day under .cache/coverage.
 *
 *   pnpm --filter @shapi/bench bench:shopify-coverage
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdvisories } from "@shapi/core";
import { parseShopifyFeed, shopifyCoverage } from "@shapi/bench";

const SINCE = "2026-01-01";
const FEED = "https://shopify.dev/changelog/feed.xml";
const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const repoRoot = path.resolve(benchRoot, "..", "..");
const cache = path.join(benchRoot, ".cache", "coverage");
mkdirSync(cache, { recursive: true });

const file = path.join(cache, `shopify-feed-${new Date().toISOString().slice(0, 10)}.xml`);
if (!existsSync(file)) {
  const res = await fetch(FEED, { headers: { "user-agent": "shapi-bench" } });
  if (!res.ok) throw new Error(`GET ${FEED}: ${res.status}`);
  writeFileSync(file, await res.text());
}
const { rows, gaps } = shopifyCoverage({
  entries: parseShopifyFeed(readFileSync(file, "utf8")),
  since: SINCE,
  advisories: loadAdvisories(path.join(repoRoot, "advisories")),
  exemptions: JSON.parse(readFileSync(path.join(benchRoot, "datasets", "shopify-coverage-exemptions.json"), "utf8")) as Record<string, string>,
});
for (const r of rows) {
  const status = r.advisories.length ? `covered by ${r.advisories.join(", ")}` : r.exempt ? `exempt: ${r.exempt}` : "GAP: no advisory cites it";
  console.log(`${r.release}  ${r.title}\n  ${r.methods.join(", ")}\n  ${status}`);
}
writeFileSync(path.join(benchRoot, "results", "shopify-coverage.json"), `${JSON.stringify({ since: SINCE, rows, gaps: gaps.length }, null, 2)}\n`);
console.log(`${rows.length} breaking Admin API entries since ${SINCE}; ${gaps.length} gaps`);
process.exit(gaps.length ? 1 : 0);
