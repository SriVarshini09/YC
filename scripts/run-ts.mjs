// Run a TypeScript script with Node's type stripping: `node scripts/run-ts.mjs <file.ts> [args...]`.
// Node 22.18+ and 23.6+ strip types by default: the script then runs in this process, so its exit code,
// its signals and a stop (Ctrl-C, a kill of this process) are exactly those of `node <file.ts>`, with no
// extra process left behind. 22.14 to 22.17 (which `engines` allows) need --experimental-strip-types, a flag
// newer versions may not keep: there the script runs in a child, whose exit code or signal is passed on.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("usage: node scripts/run-ts.mjs <file.ts> [args...]");
  process.exit(2);
}
const file = path.resolve(script);

if (process.features.typescript) {
  // As `node <file.ts> [args...]` sees them.
  process.argv = [process.argv[0], file, ...args];
  await import(pathToFileURL(file).href);
} else {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", file, ...args], { stdio: "inherit" });
  child.on("error", (err) => {
    throw err;
  });
  // Ctrl-C reaches every process of the terminal (on Windows, of the console) by itself: the script handles
  // it, and this process waits for it to finish. A signal sent to this process alone is passed on.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP", "SIGBREAK"]) if (signal in constants.signals) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    // Die of the same signal (exit status 128+n), as the script did.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
