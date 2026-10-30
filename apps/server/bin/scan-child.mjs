// One static scan in its own process (execution plan I-01). The worker starts it with a memory cap, so a
// repository too large for memory fails alone instead of taking the worker and every other job down.
// Usage: node --max-old-space-size=<MB> scan-child.mjs <repository dir> <api.lock output file>
import { writeFileSync } from "node:fs";
import process from "node:process";
import { createApiLock } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  process.stderr.write("usage: scan-child.mjs <repository dir> <api.lock output file>\n");
  process.exit(2);
}
await loadPythonParser();
writeFileSync(out, JSON.stringify(createApiLock(extractCallSites(dir), "shapi cloud")));
