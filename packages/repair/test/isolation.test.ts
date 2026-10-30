import { afterEach, describe, expect, it } from "vitest";
import { assertNoSecrets, type ExecResult, type Sandbox, type SnapshotFile } from "@shapi/sandbox";
import { sandboxWorkspace } from "@shapi/repair";

// Execution plan I-04: everything a fix runs in a sandbox (install, contract tests, the repository's suite, the
// type-check) gets an environment with no credential in it, while the worker holds its keys.
const KEYS = {
  ANTHROPIC_API_KEY: "sk-ant-shapi-test-0123456789abcdef",
  SHAPI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY----- shapi-test",
  SHAPI_STRIPE_TEST_KEY: "sk_test_shapi0123456789",
  E2B_API_KEY: "e2b_shapi_test_0123456789",
};
afterEach(() => {
  for (const k of Object.keys(KEYS)) delete process.env[k];
});

describe("the fix workspace", () => {
  it("passes no credential into any sandbox command", async () => {
    Object.assign(process.env, KEYS);
    const envs: Record<string, string>[] = [];
    const files = new Map<string, string>();
    const sandbox: Sandbox = {
      provider: "e2b",
      id: "iso-1",
      root: "/home/user/repo",
      async write(fs: SnapshotFile[]) {
        for (const f of fs) files.set(f.path, String(f.content));
      },
      async read(file) {
        if (file === "node_modules/vitest/package.json" || file === "node_modules/typescript/package.json") return "{}";
        return files.get(file);
      },
      async exec(_command: string, _args: string[], opts = {}): Promise<ExecResult> {
        envs.push(opts.env ?? {});
        return { exitCode: 0, stdout: " Tests  1 passed (1)", stderr: "", timedOut: false };
      },
      async setNetwork() {},
      async extend() {},
      async close() {},
    };
    const repo: SnapshotFile[] = [
      { path: "package.json", content: JSON.stringify({ scripts: { test: "vitest run" } }) },
      { path: "package-lock.json", content: "{}" },
      { path: "tsconfig.json", content: "{}" },
      { path: "src/a.ts", content: "export const a = 1;" },
    ];
    const ws = await sandboxWorkspace(sandbox, repo);
    await ws.runTest("test/shapi/a.test.ts");
    await ws.runTest("test/shapi/test_a.py");
    await ws.runSuite?.();
    await ws.typecheck?.("tsconfig.json");
    expect(envs.length).toBeGreaterThanOrEqual(4);
    for (const env of envs) {
      expect(() => assertNoSecrets(env)).not.toThrow();
      for (const value of Object.values(KEYS)) expect(JSON.stringify(env)).not.toContain(value);
    }
  });
});
