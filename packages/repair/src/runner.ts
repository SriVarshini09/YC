import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/**
 * What repo code and tests run with on the developer's machine: enough for Node and the OS, none of
 * the caller's tokens or keys (ANTHROPIC_API_KEY, GITHUB_TOKEN, …). The code that runs can include an
 * LLM-written change nobody has reviewed yet.
 */
export function runEnv(): Record<string, string> {
  const keep = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG"];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return { ...env, FORCE_COLOR: "0", CI: "1" };
}

/** Config files vitest picks up at a repository root, in its order of preference. */
export const VITEST_CONFIGS = ["vitest", "vite"].flatMap((n) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${n}.config.${ext}`));

/** Where SHAPI writes the config its contract test runs use, when the repository has a vitest config of its own. */
export const SHAPI_VITEST_CONFIG = "test/shapi/vitest.config.mjs";

/**
 * The repository's vitest config with test discovery set to SHAPI's contract tests. A repo `include`
 * such as `src/**\/*.test.ts` (or `exclude`, `dir`, `projects`) would otherwise filter the generated
 * test out, and vitest would find no test to run. Everything else (aliases, plugins, setup files,
 * environment) stays the repository's.
 */
export function shapiVitestConfig(repoConfig: string): string {
  return `// Written by SHAPI for its contract test runs; not part of any fix.
import { fileURLToPath } from "node:url";
import repo from "../../${repoConfig}";

const base = (await (typeof repo === "function" ? repo({ command: "serve", mode: "test" }) : repo)) ?? {};
export default {
  ...base,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: { ...base.test, include: ["test/shapi/**/*.test.ts"], exclude: ["**/node_modules/**", "**/.git/**"], dir: undefined, projects: undefined, passWithNoTests: false },
};
`;
}

/** The Python a contract test runs with: SHAPI_PYTHON, else `python` on Windows and `python3` elsewhere. */
export const pythonCommand = () => process.env.SHAPI_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

/** Run one test file with vitest, rooted at `dir`; a Python contract test (`.py`) runs as a script. */
export function runTestFile(dir: string, file: string, timeoutMs = 120_000): TestRun {
  if (file.endsWith(".py")) {
    const res = spawnSync(pythonCommand(), [file], { cwd: dir, encoding: "utf8", timeout: timeoutMs, env: { ...runEnv(), PYTHONDONTWRITEBYTECODE: "1" } });
    const exitCode = res.status ?? 1;
    return { passed: exitCode === 0, exitCode, output: `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `
${res.error.message}` : ""}` };
  }
  const repoConfig = VITEST_CONFIGS.find((c) => existsSync(path.join(dir, c)));
  const config: string[] = [];
  if (repoConfig) {
    mkdirSync(path.join(dir, path.dirname(SHAPI_VITEST_CONFIG)), { recursive: true });
    writeFileSync(path.join(dir, SHAPI_VITEST_CONFIG), shapiVitestConfig(repoConfig));
    config.push("--config", SHAPI_VITEST_CONFIG);
  }
  const res = spawnSync(process.execPath, [vitestCli(dir), "run", file, "--root", dir, ...config, "--reporter", "verbose", "--no-color"], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMs,
    env: runEnv(),
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}`;
  const exitCode = res.status ?? 1;
  return { passed: exitCode === 0, exitCode, output };
}

/**
 * Whether vitest actually ran tests (its summary counts them). A startup crash, an import error or
 * "no tests" fails too, but proves nothing about the code under test.
 */
export function testsRan(output: string): boolean {
  return /^\s*Tests\s+.*\d+ (?:failed|passed)/m.test(output);
}

/**
 * The counts of vitest's own summary line, for example "1 failed | 2 passed". Only a whole line of counts
 * matches, and the last one wins: vitest prints it after the output of the code under test, which could
 * print a look-alike line holding Markdown.
 */
export function testCounts(output: string): string | undefined {
  const lines = [...output.matchAll(/^[ \t]*Tests[ \t]+(\d+ [a-z]+(?: \| \d+ [a-z]+)*)[ \t]+\(\d+\)[ \t]*\r?$/gm)];
  return lines.at(-1)?.[1];
}

/** The first line that explains why a run did not get as far as running tests. */
export function runFailure(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  // "SyntaxError: ..." says more than a banner such as "Startup Error".
  return (
    lines.find((l) => /\b\w*Error: |\berror: /i.test(l)) ??
    lines.find((l) => /Cannot find|not found|No test files found|Error/.test(l)) ??
    lines[0] ??
    "no output"
  );
}
