/**
 * Write the endpoints the sensor records (src/endpoints.json, copied to python/shapi_sensor/endpoints.json): every
 * endpoint an advisory names, with its provider's hosts and a regular expression for concrete request paths. A
 * request that matches none is never recorded, and a recorded one is reported under the pattern, never its own path.
 *
 *   pnpm --filter @shapi/sensor endpoints
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, loadAdvisories } from "@shapi/core";
import { patternRegex, type SensorEndpoint } from "../src/endpoints.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const seen = new Map<string, SensorEndpoint>();
for (const a of loadAdvisories(path.join(root, "advisories"))) {
  const hosts = a.endpoint.hosts ?? getProvider(a.provider)?.hosts;
  if (!hosts) continue;
  const e: SensorEndpoint = { provider: a.provider, method: a.endpoint.method, path: a.endpoint.path, hosts: [...hosts].sort(), re: patternRegex(a.endpoint.path) };
  seen.set(`${e.provider} ${e.method} ${e.path} ${e.hosts.join(",")}`, e);
}
const list = [...seen.values()].sort((x, y) => x.provider.localeCompare(y.provider) || x.path.localeCompare(y.path) || x.method.localeCompare(y.method));
const json = JSON.stringify(list, null, 2) + "\n";
for (const out of [path.join(here, "..", "src", "endpoints.json"), path.join(here, "..", "python", "shapi_sensor", "endpoints.json")]) writeFileSync(out, json);
console.log(`${list.length} endpoints`);
