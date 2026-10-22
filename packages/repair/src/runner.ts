import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface TestRun {
  passed: boolean;
  exitCode: number;
  output: string;
}

/** The repo's own vitest when it has one, otherwise the one SHAPI ships with. */
function vitestCli(dir: string): string {
  const local = path.join(dir, "node_modules", "vitest", "vitest.mjs");
  if (existsSync(local)) return local;
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
}

/** Run one test file with vitest, rooted at `dir`. */
export function runTestFile(dir: string, file: string, timeoutMs = 120_000): TestRun {
  const res = spawnSync(process.execPath, [vitestCli(dir), "run", file, "--root", dir, "--reporter", "verbose", "--no-color"], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, FORCE_COLOR: "0", CI: "1" },
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}`;
  const exitCode = res.status ?? 1;
  return { passed: exitCode === 0, exitCode, output };
}
