import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SandboxLifetimeError, lifetime, localProvider, readSnapshot, safeRelative, sandboxFromEnv, shellQuote, truncate } from "@shapi/sandbox";

const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-sandbox-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("paths and quoting", () => {
  it("refuses paths that escape the repository", () => {
    expect(safeRelative("src/a.ts")).toBe("src/a.ts");
    expect(safeRelative("./src//b.ts")).toBe("src/b.ts");
    expect(safeRelative("src\\c.ts")).toBe("src/c.ts");
    for (const bad of ["../x", "src/../../x", "/etc/passwd", "C:/Windows", ""]) expect(() => safeRelative(bad)).toThrow(/outside the repository/);
  });

  it("quotes shell arguments so they reach the program unchanged", () => {
    expect(shellQuote("vitest@5.0.5")).toBe("vitest@5.0.5");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("keeps the start and end of very long output", () => {
    const long = `${"a".repeat(100_000)}END`;
    const cut = truncate(long);
    expect(cut.length).toBeLessThan(70_000);
    expect(cut.endsWith("END")).toBe(true);
    expect(cut).toContain("characters cut");
  });
});

describe("provider selection", () => {
  it("uses E2B when a key is set, refuses the local sandbox in production", () => {
    expect(sandboxFromEnv({ E2B_API_KEY: "k" }).name).toBe("e2b");
    expect(sandboxFromEnv({}).name).toBe("local");
    expect(() => sandboxFromEnv({ SHAPI_SANDBOX: "e2b" })).toThrow(/needs E2B_API_KEY/);
    expect(() => sandboxFromEnv({ NODE_ENV: "production" })).toThrow(/refused in production/);
    expect(() => sandboxFromEnv({ SHAPI_SANDBOX: "docker" })).toThrow(/unknown SHAPI_SANDBOX/);
  });
});

describe("snapshot", () => {
  it("reads a checkout without history, dependencies or build output, within limits", () => {
    const repo = path.join(tmp, "repo");
    for (const d of ["src", ".git", "node_modules/x", "dist"]) mkdirSync(path.join(repo, d), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), "{}");
    writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, ".git/HEAD"), "ref");
    writeFileSync(path.join(repo, "node_modules/x/index.js"), "");
    writeFileSync(path.join(repo, "dist/a.js"), "");
    writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(2048));
    const files = readSnapshot(repo, { maxFiles: 10, maxBytes: 10_000, maxFileBytes: 1024 });
    expect(files.map((f) => f.path).sort()).toEqual(["package.json", "src/a.ts"]);
    expect(() => readSnapshot(repo, { maxFiles: 1, maxBytes: 10_000, maxFileBytes: 1024 })).toThrow(/larger than the sandbox limit/);
  });

  it("never leaves out a lockfile or package.json for its size", () => {
    const repo = path.join(tmp, "big-lock");
    mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), " ".repeat(2048));
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "x".repeat(4096));
    writeFileSync(path.join(repo, "packages", "a", "package.json"), " ".repeat(2048));
    writeFileSync(path.join(repo, "big.json"), " ".repeat(2048));
    const files = readSnapshot(repo, { maxFiles: 10, maxBytes: 100_000, maxFileBytes: 1024 });
    expect(files.map((f) => f.path).sort()).toEqual(["package.json", "packages/a/package.json", "pnpm-lock.yaml"]);
  });
});

describe("sandbox lifetime", () => {
  it("extends only when asked for more than is left, and stops with a clear error past the limit", async () => {
    const set: number[] = [];
    const extend = lifetime({ lifetimeMs: 60_000, maxLifetimeMs: 10 * 60_000 }, (ms) => void set.push(ms));
    await extend(30_000);
    expect(set).toEqual([]);
    await extend(5 * 60_000);
    expect(set).toHaveLength(1);
    expect(set[0]).toBeGreaterThan(4 * 60_000);
    await expect(extend(11 * 60_000)).rejects.toThrow("the sandbox reached its 10-minute lifetime limit: the job needs more time than one sandbox allows");
    // A typed error, so a fix job can tell it from a failed fix and deliver what it already verified.
    await expect(extend(11 * 60_000)).rejects.toBeInstanceOf(SandboxLifetimeError);
  });
});

describe("local sandbox", () => {
  it("writes, reads and runs inside its own folder with a minimal environment, then removes it", async () => {
    process.env.SHAPI_TEST_SECRET = "do-not-leak";
    const sb = await localProvider().create();
    try {
      await sb.write([{ path: "src/a.txt", content: "hello" }, { path: "bin.dat", content: Buffer.from([1, 2, 3]) }]);
      expect(await sb.read("src/a.txt")).toBe("hello");
      expect(await sb.read("missing.txt")).toBeUndefined();
      const r = await sb.exec(process.execPath, ["-e", "console.log(process.cwd(), process.env.SHAPI_TEST_SECRET ?? 'none', process.env.CI)"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(sb.root);
      expect(r.stdout).toContain("none 1");
      const fail = await sb.exec(process.execPath, ["-e", "process.exit(3)"]);
      expect(fail.exitCode).toBe(3);
      const slow = await sb.exec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 });
      expect(slow).toMatchObject({ timedOut: true, exitCode: 124 });
      await expect(sb.write([{ path: "../escape.txt", content: "x" }])).rejects.toThrow(/outside the repository/);
    } finally {
      delete process.env.SHAPI_TEST_SECRET;
      await sb.close();
      await sb.close();
    }
    expect(await sb.read("src/a.txt")).toBeUndefined();
  });
});
