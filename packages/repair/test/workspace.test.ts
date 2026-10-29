import { describe, expect, it } from "vitest";
import type { ExecResult, NetworkMode, Sandbox, SandboxProvider, SnapshotFile } from "@shapi/sandbox";
import { RUNNER_VITEST, sandboxWorkspace, withSandboxWorkspace } from "@shapi/repair";

/** A sandbox that records every step, so the order of network changes and commands can be checked. */
function recordingSandbox(opts: { installExit?: number; vitestInstalled?: boolean; testExit?: number; closeFails?: boolean } = {}) {
  const files = new Map<string, string>();
  const log: string[] = [];
  let network: NetworkMode = "off";
  const sandbox: Sandbox = {
    provider: "local",
    id: "rec-1",
    root: "/repo",
    async write(fs: SnapshotFile[]) {
      for (const f of fs) files.set(f.path, String(f.content));
      log.push(`write ${fs.length}`);
    },
    async read(file) {
      if (file === "node_modules/vitest/package.json") return opts.vitestInstalled ? "{}" : undefined;
      return files.get(file);
    },
    async exec(command: string, args: string[]): Promise<ExecResult> {
      log.push(`exec[${network}] ${[command, ...args].join(" ")}`);
      const isInstall = /install|ci|add/.test(args.join(" ")) && command !== "node";
      const exitCode = isInstall ? (opts.installExit ?? 0) : (opts.testExit ?? 0);
      return { exitCode, stdout: "out", stderr: "", timedOut: false };
    },
    async setNetwork(mode) {
      network = mode;
      log.push(`network ${mode}`);
    },
    async extend(ms: number) {
      log.push(`extend ${ms}`);
    },
    async close() {
      log.push("close");
      if (opts.closeFails) throw new Error("kill failed");
    },
  };
  return { sandbox, log, files };
}

const npmRepo: SnapshotFile[] = [
  { path: "package.json", content: "{}" },
  { path: "package-lock.json", content: "{}" },
  { path: "src/a.ts", content: "a" },
];

describe("sandbox workspace", () => {
  it("installs with only the registry reachable, then cuts the network before any test runs", async () => {
    const { sandbox, log } = recordingSandbox({ vitestInstalled: true });
    const ws = await sandboxWorkspace(sandbox, npmRepo);
    await ws.write("test/shapi/x.test.ts", "test");
    const run = await ws.runTest("test/shapi/x.test.ts");
    expect(run.passed).toBe(true);
    expect(log).toEqual([
      "write 3",
      "network registry",
      // each command first makes sure the sandbox lives long enough for it
      `extend ${10 * 60_000 + 2 * 60_000}`,
      "exec[registry] npm ci --no-audit --no-fund",
      "network off",
      "write 1",
      `extend ${120_000 + 2 * 60_000}`,
      "exec[off] node node_modules/vitest/vitest.mjs run test/shapi/x.test.ts --reporter verbose --no-color",
    ]);
    expect(ws.install).toMatchObject({ packageManager: "npm", exitCode: 0, addedVitest: false });
    expect(ws.location).toBe("local:rec-1");
  });

  it("picks the repository's package manager and adds vitest when the repo has none", async () => {
    const pnpm = recordingSandbox();
    await sandboxWorkspace(pnpm.sandbox, [{ path: "package.json", content: "{}" }, { path: "pnpm-lock.yaml", content: "" }]);
    expect(pnpm.log.filter((l) => l.startsWith("exec"))).toEqual([
      "exec[registry] corepack pnpm install --frozen-lockfile",
      `exec[registry] corepack pnpm add -D ${RUNNER_VITEST}`,
    ]);
    const bare = recordingSandbox();
    const ws = await sandboxWorkspace(bare.sandbox, [{ path: "package.json", content: "{}" }]);
    expect(bare.log.filter((l) => l.startsWith("exec"))).toEqual([
      "exec[registry] npm install --no-audit --no-fund",
      `exec[registry] npm install --no-save --no-audit --no-fund ${RUNNER_VITEST}`,
    ]);
    expect(ws.install.addedVitest).toBe(true);
    expect(bare.log.at(-1)).toBe("network off");
  });

  it("stops with the network off when the install fails", async () => {
    const { sandbox, log } = recordingSandbox({ installExit: 1 });
    await expect(sandboxWorkspace(sandbox, npmRepo)).rejects.toThrow(/dependency install failed \(npm ci --no-audit --no-fund, exit 1\)/);
    expect(log.at(-1)).toBe("network off");
  });

  it("runs the contract test with SHAPI's config when the repo has a vitest config, and deletes files", async () => {
    const { sandbox, log, files } = recordingSandbox({ vitestInstalled: true });
    const ws = await sandboxWorkspace(sandbox, [...npmRepo, { path: "vitest.config.ts", content: "export default {}" }]);
    await ws.runTest("test/shapi/x.test.ts");
    expect(files.get("test/shapi/vitest.config.mjs")).toContain('import repo from "../../vitest.config.ts";');
    expect(log.at(-1)).toBe("exec[off] node node_modules/vitest/vitest.mjs run test/shapi/x.test.ts --config test/shapi/vitest.config.mjs --reporter verbose --no-color");
    await ws.remove("src/new.ts");
    expect(log.at(-1)).toBe("exec[off] node -e require('node:fs').rmSync(process.argv[1], { force: true }) src/new.ts");
  });

  it("type-checks with the repository's own TypeScript, if it has one", async () => {
    const without = recordingSandbox({ vitestInstalled: true });
    expect(await (await sandboxWorkspace(without.sandbox, npmRepo)).typecheck!("tsconfig.json")).toBeUndefined();
    const withTs = recordingSandbox({ vitestInstalled: true });
    withTs.files.set("node_modules/typescript/package.json", "{}");
    const ws = await sandboxWorkspace(withTs.sandbox, npmRepo);
    expect((await ws.typecheck!("packages/a/tsconfig.json"))?.passed).toBe(true);
    expect(withTs.log.at(-1)).toBe("exec[off] node node_modules/typescript/lib/tsc.js --noEmit -p packages/a/tsconfig.json --pretty false");
  });

  it("always destroys the sandbox, also when the work throws", async () => {
    const rec = recordingSandbox({ vitestInstalled: true });
    const provider: SandboxProvider = { name: "local", create: async () => rec.sandbox };
    await expect(withSandboxWorkspace(provider, npmRepo, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(rec.log.at(-1)).toBe("close");
    const ok = recordingSandbox({ vitestInstalled: true });
    expect(await withSandboxWorkspace({ name: "local", create: async () => ok.sandbox }, npmRepo, async (ws) => (await ws.runTest("t.ts")).passed)).toBe(true);
    expect(ok.log.at(-1)).toBe("close");
  });

  it("reports why the work failed even when destroying the sandbox fails too", async () => {
    const rec = recordingSandbox({ vitestInstalled: true, closeFails: true });
    await expect(withSandboxWorkspace({ name: "local", create: async () => rec.sandbox }, npmRepo, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
