import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sandbox, SandboxProvider, SnapshotFile } from "@shapi/sandbox";
import { runTestFile, type TestRun } from "./runner";

/** A working copy of a repository where the repair agent edits files and runs the contract test. */
export interface Workspace {
  /** Where the copy lives: a local folder, or "<provider>:<sandbox id>". */
  location: string;
  read(file: string): Promise<string | undefined>;
  write(file: string, content: string): Promise<void>;
  runTest(file: string): Promise<TestRun>;
}

const COPY_SKIP = new Set([".git", "node_modules", "dist", "coverage", ".shapi"]);

/**
 * A temp copy of a local checkout that links the repo's own node_modules. For the CLI and the MCP
 * server running on the developer's machine against their own code; not for untrusted code.
 */
export function localWorkspace(repoDir: string): Workspace {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-repair-"));
  cpSync(repoDir, dir, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(path.basename(src)) || path.resolve(src) === path.resolve(repoDir),
  });
  const modules = path.join(repoDir, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, path.join(dir, "node_modules"), "junction");
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
    async runTest(file) {
      return runTestFile(dir, file);
    },
  };
}

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

/**
 * Put a repository snapshot into a sandbox and install its dependencies with only the npm
 * registries reachable; then cut the network entirely before any of the repository's code or tests
 * run. Install scripts do run, but inside the sandbox, with no secrets and no other hosts reachable.
 */
export async function sandboxWorkspace(
  sandbox: Sandbox,
  files: SnapshotFile[],
  opts: { installTimeoutMs?: number; testTimeoutMs?: number } = {},
): Promise<Workspace & { install: InstallReport }> {
  await sandbox.write(files);
  const manager = detect(files);
  let install: InstallReport = { packageManager: manager, command: "", exitCode: 0, output: "", addedVitest: false };
  if (manager !== "none") {
    await sandbox.setNetwork("registry");
    const [cmd, args] = INSTALL[manager](files.some((f) => f.path === "package-lock.json"));
    const r = await sandbox.exec(cmd, args, { timeoutMs: opts.installTimeoutMs ?? 10 * 60_000, env: ENV });
    install = { packageManager: manager, command: [cmd, ...args].join(" "), exitCode: r.exitCode, output: `${r.stdout}${r.stderr}`, addedVitest: false };
    if (r.exitCode !== 0) {
      await sandbox.setNetwork("off");
      throw Object.assign(new Error(`dependency install failed (${install.command}, exit ${r.exitCode})`), { install });
    }
    const hasVitest = (await sandbox.read("node_modules/vitest/package.json")) !== undefined;
    if (!hasVitest) {
      const [vcmd, vargs] = ADD_VITEST[manager];
      const v = await sandbox.exec(vcmd, vargs, { timeoutMs: opts.installTimeoutMs ?? 10 * 60_000, env: ENV });
      install = { ...install, addedVitest: v.exitCode === 0, output: `${install.output}${v.stdout}${v.stderr}` };
    }
  }
  // From here on the repository's own code runs: no network at all.
  await sandbox.setNetwork("off");

  return {
    location: `${sandbox.provider}:${sandbox.id}`,
    install,
    read: (file) => sandbox.read(file),
    write: (file, content) => sandbox.write([{ path: file, content }]),
    async runTest(file) {
      const r = await sandbox.exec("node", ["node_modules/vitest/vitest.mjs", "run", file, "--reporter", "verbose", "--no-color"], {
        timeoutMs: opts.testTimeoutMs ?? 120_000,
        env: ENV,
      });
      const output = `${r.stdout}${r.stderr}${r.timedOut ? "\n(test run timed out)" : ""}`;
      return { passed: r.exitCode === 0, exitCode: r.exitCode, output };
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
  try {
    return await fn(await sandboxWorkspace(sandbox, files, opts));
  } finally {
    await sandbox.close();
  }
}
