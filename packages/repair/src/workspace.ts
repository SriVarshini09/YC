import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sandbox, SandboxProvider, SnapshotFile } from "@shapi/sandbox";
import { runEnv, runTestFile, shapiVitestConfig, SHAPI_VITEST_CONFIG, VITEST_CONFIGS, type TestRun } from "./runner";
import { suiteCommand, type SuiteRun } from "./suite";
import { upward } from "./typecheck";

/** A working copy of a repository where the repair agent edits files and runs the contract test. */
export interface Workspace {
  /** Where the copy lives: a local folder, or "<provider>:<sandbox id>". */
  location: string;
  read(file: string): Promise<string | undefined>;
  write(file: string, content: string): Promise<void>;
  /** Delete a file; nothing happens when it does not exist. */
  remove(file: string): Promise<void>;
  runTest(file: string): Promise<TestRun>;
  /**
   * Type-check the project of `tsconfig` (repo-relative) with the repository's own TypeScript:
   * `tsc --noEmit -p <tsconfig>`. Undefined when the repository has no TypeScript installed.
   */
  typecheck?(tsconfig: string): Promise<TestRun | undefined>;
  /** Run the repository's own test command (see suiteCommand). Undefined when it has none. */
  runSuite?(): Promise<SuiteRun | undefined>;
}

/** How long the repository's own test command may take. */
const SUITE_TIMEOUT_MS = 10 * 60_000;

/** The repository's test command, read from the workspace's package.json and lockfiles. */
async function suiteFor(read: (file: string) => Promise<string | undefined>): Promise<[string, string[]] | undefined> {
  return suiteCommand(await read("package.json"), { pnpm: (await read("pnpm-lock.yaml")) !== undefined, yarn: (await read("yarn.lock")) !== undefined });
}

/** Skipped anywhere in the tree: history. Nested node_modules are linked, not copied. */
const COPY_SKIP = new Set([".git", "node_modules"]);
/** Skipped at the repository root only: build output and local state. A package's committed dist/ can be imported code. */
const ROOT_SKIP = new Set(["dist", "coverage", ".shapi"]);

/** How long one type-check may take. */
const TYPECHECK_TIMEOUT_MS = 5 * 60_000;

/**
 * A temp copy of a local checkout that links the repo's own node_modules (at the root and in each
 * package). For the CLI and the MCP server running on the developer's machine against their own code;
 * not for untrusted code. The copy holds everything the checkout does, `.env` files included, so call
 * `dispose()` once done.
 */
export function localWorkspace(repoDir: string): Workspace & { dispose(): Promise<void> } {
  const root = path.resolve(repoDir);
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-repair-"));
  const modules: string[] = [];
  try {
    cpSync(root, dir, {
      recursive: true,
      filter: (src) => {
        const abs = path.resolve(src);
        if (abs === root) return true;
        const name = path.basename(abs);
        if (name === "node_modules") modules.push(path.relative(root, abs));
        return !COPY_SKIP.has(name) && !(ROOT_SKIP.has(name) && path.dirname(abs) === root);
      },
    });
    for (const rel of modules) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      symlinkSync(path.join(root, rel), path.join(dir, rel), "junction");
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    throw err;
  }
  return {
    location: dir,
    async read(file) {
      const abs = path.join(dir, file);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    async write(file, content) {
      const abs = path.join(dir, file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    async remove(file) {
      rmSync(path.join(dir, file), { force: true });
    },
    async runTest(file) {
      return runTestFile(dir, file);
    },
    async typecheck(tsconfig) {
      const at = await upward(path.posix.dirname(tsconfig), (d) => existsSync(path.join(dir, d, TSC)));
      if (at === undefined) return undefined;
      const res = spawnSync(process.execPath, [path.join(dir, at, TSC), ...TSC_ARGS(tsconfig)], { cwd: dir, encoding: "utf8", timeout: TYPECHECK_TIMEOUT_MS, env: runEnv(), maxBuffer: 64 * 1024 * 1024 });
      const exitCode = res.status ?? 1;
      return { passed: exitCode === 0, exitCode, output: `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}` };
    },
    async runSuite() {
      const command = await suiteFor(async (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8") : undefined));
      if (!command) return undefined;
      const [cmd, args] = command;
      // npm and corepack are .cmd shims on Windows, which only a shell runs.
      const res = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, env: runEnv(), maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
      const exitCode = res.status ?? 1;
      return { passed: exitCode === 0, exitCode, output: `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? `\n${res.error.message}` : ""}`, command: [cmd, ...args].join(" ") };
    },
    // Junctions are removed as links: the checkout's own node_modules are left alone.
    async dispose() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** TypeScript's compiler, relative to a folder holding node_modules. */
const TSC = "node_modules/typescript/lib/tsc.js";
const TSC_ARGS = (tsconfig: string) => ["--noEmit", "-p", tsconfig, "--pretty", "false"];

/** The vitest SHAPI installs when a repository has none of its own. */
export const RUNNER_VITEST = "vitest@5.0.5";

export interface InstallReport {
  packageManager: "pnpm" | "yarn" | "npm" | "none";
  command: string;
  exitCode: number;
  output: string;
  /** vitest was missing and SHAPI added its own. */
  addedVitest: boolean;
}

type Manager = InstallReport["packageManager"];

function detect(files: SnapshotFile[]): Manager {
  const has = (name: string) => files.some((f) => f.path === name);
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("package.json")) return "npm";
  return "none";
}

const INSTALL: Record<Exclude<Manager, "none">, (locked: boolean) => [string, string[]]> = {
  pnpm: () => ["corepack", ["pnpm", "install", "--frozen-lockfile"]],
  yarn: () => ["corepack", ["yarn", "install", "--immutable"]],
  npm: (locked) => ["npm", locked ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"]],
};

const ADD_VITEST: Record<Exclude<Manager, "none">, [string, string[]]> = {
  pnpm: ["corepack", ["pnpm", "add", "-D", RUNNER_VITEST]],
  yarn: ["corepack", ["yarn", "add", "-D", RUNNER_VITEST]],
  npm: ["npm", ["install", "--no-save", "--no-audit", "--no-fund", RUNNER_VITEST]],
};

const ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_update_notifier: "false" };

/** Extra lifetime asked for on top of each command's own timeout, for the steps around it. */
const LIFETIME_MARGIN_MS = 2 * 60_000;

/**
 * Put a repository snapshot into a sandbox and install its dependencies with only the npm
 * registries reachable; then cut the network entirely before any of the repository's code or tests
 * run. Install scripts do run, but inside the sandbox, with no secrets and no other hosts reachable.
 * Before each command the sandbox's lifetime is extended to cover it (see Sandbox.extend).
 */
export async function sandboxWorkspace(
  sandbox: Sandbox,
  files: SnapshotFile[],
  opts: { installTimeoutMs?: number; testTimeoutMs?: number } = {},
): Promise<Workspace & { install: InstallReport }> {
  const exec: Sandbox["exec"] = async (command, args, eo = {}) => {
    await sandbox.extend((eo.timeoutMs ?? 120_000) + LIFETIME_MARGIN_MS);
    return sandbox.exec(command, args, eo);
  };
  await sandbox.write(files);
  const manager = detect(files);
  let install: InstallReport = { packageManager: manager, command: "", exitCode: 0, output: "", addedVitest: false };
  if (manager !== "none") {
    await sandbox.setNetwork("registry");
    const [cmd, args] = INSTALL[manager](files.some((f) => f.path === "package-lock.json"));
    const r = await exec(cmd, args, { timeoutMs: opts.installTimeoutMs ?? 10 * 60_000, env: ENV });
    install = { packageManager: manager, command: [cmd, ...args].join(" "), exitCode: r.exitCode, output: `${r.stdout}${r.stderr}`, addedVitest: false };
    if (r.exitCode !== 0) {
      await sandbox.setNetwork("off");
      throw Object.assign(new Error(`dependency install failed (${install.command}, exit ${r.exitCode})`), { install });
    }
    const hasVitest = (await sandbox.read("node_modules/vitest/package.json")) !== undefined;
    if (!hasVitest) {
      const [vcmd, vargs] = ADD_VITEST[manager];
      const v = await exec(vcmd, vargs, { timeoutMs: opts.installTimeoutMs ?? 10 * 60_000, env: ENV });
      install = { ...install, addedVitest: v.exitCode === 0, output: `${install.output}${v.stdout}${v.stderr}` };
    }
  }
  // From here on the repository's own code runs: no network at all.
  await sandbox.setNetwork("off");
  const repoConfig = VITEST_CONFIGS.find((c) => files.some((f) => f.path === c));
  const output = (r: { stdout: string; stderr: string; timedOut: boolean }, what: string) => `${r.stdout}${r.stderr}${r.timedOut ? `\n(${what} timed out)` : ""}`;

  return {
    location: `${sandbox.provider}:${sandbox.id}`,
    install,
    read: (file) => sandbox.read(file),
    write: (file, content) => sandbox.write([{ path: file, content }]),
    async remove(file) {
      await exec("node", ["-e", "require('node:fs').rmSync(process.argv[1], { force: true })", file], { env: ENV });
    },
    async runTest(file) {
      if (file.endsWith(".py")) {
        const r = await exec("python3", [file], { timeoutMs: opts.testTimeoutMs ?? 120_000, env: { ...ENV, PYTHONDONTWRITEBYTECODE: "1" } });
        return { passed: r.exitCode === 0, exitCode: r.exitCode, output: output(r, "test run") };
      }
      const config: string[] = [];
      if (repoConfig) {
        await sandbox.write([{ path: SHAPI_VITEST_CONFIG, content: shapiVitestConfig(repoConfig) }]);
        config.push("--config", SHAPI_VITEST_CONFIG);
      }
      const r = await exec("node", ["node_modules/vitest/vitest.mjs", "run", file, ...config, "--reporter", "verbose", "--no-color"], {
        timeoutMs: opts.testTimeoutMs ?? 120_000,
        env: ENV,
      });
      return { passed: r.exitCode === 0, exitCode: r.exitCode, output: output(r, "test run") };
    },
    async typecheck(tsconfig) {
      const at = await upward(path.posix.dirname(tsconfig), async (d) => (await sandbox.read(path.posix.join(d, "node_modules/typescript/package.json"))) !== undefined);
      if (at === undefined) return undefined;
      const r = await exec("node", [path.posix.join(at, TSC), ...TSC_ARGS(tsconfig)], { timeoutMs: TYPECHECK_TIMEOUT_MS, env: ENV });
      return { passed: r.exitCode === 0, exitCode: r.exitCode, output: output(r, "type-check") };
    },
    async runSuite() {
      const command = await suiteFor((f) => sandbox.read(f));
      if (!command) return undefined;
      const [cmd, args] = command;
      // The network is already off: the tests run with nothing reachable.
      const r = await exec(cmd, args, { timeoutMs: SUITE_TIMEOUT_MS, env: { ...ENV, CI: "1" } });
      return { passed: r.exitCode === 0, exitCode: r.exitCode, output: output(r, "test command"), command: [cmd, ...args].join(" ") };
    },
  };
}

/** Create a sandbox, set up the workspace, run `fn`, and always destroy the sandbox afterwards. */
export async function withSandboxWorkspace<T>(
  provider: SandboxProvider,
  files: SnapshotFile[],
  fn: (ws: Workspace & { install: InstallReport }) => Promise<T>,
  opts: { lifetimeMs?: number; labels?: Record<string, string>; installTimeoutMs?: number; testTimeoutMs?: number } = {},
): Promise<T> {
  const sandbox = await provider.create({ lifetimeMs: opts.lifetimeMs, labels: opts.labels, network: "off" });
  let result: T;
  try {
    result = await fn(await sandboxWorkspace(sandbox, files, opts));
  } catch (err) {
    // A failing close must not hide why the work failed.
    await sandbox.close().catch(() => {});
    throw err;
  }
  await sandbox.close();
  return result;
}
