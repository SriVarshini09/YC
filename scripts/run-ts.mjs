// Run a TypeScript script with Node's type stripping: `node scripts/run-ts.mjs <file.ts> [args...]`.
// Node 22.18+ and 23.6+ strip types by default; 22.14 to 22.17 (which `engines` allows) need
// --experimental-strip-types, a flag newer versions may not keep. So it is passed only when needed.
import { spawnSync } from "node:child_process";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: node scripts/run-ts.mjs <file.ts> [args...]");
  process.exit(2);
}
const flags = process.features.typescript ? [] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const run = spawnSync(process.execPath, [...flags, script, ...args], { stdio: "inherit" });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
