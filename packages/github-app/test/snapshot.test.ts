import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { create } from "tar";
import { fetchRepoSnapshot, parseTarball } from "@shapi/github-app";

const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-tarball-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A tarball shaped like GitHub's: everything under one "<owner>-<repo>-<sha>/" folder. */
async function githubTarball(): Promise<Buffer> {
  const top = path.join(tmp, "acme-demo-abc1234");
  for (const d of ["src", ".git", "node_modules/x"]) mkdirSync(path.join(top, d), { recursive: true });
  writeFileSync(path.join(top, "package.json"), '{"name":"demo"}');
  writeFileSync(path.join(top, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(top, ".git/HEAD"), "ref");
  writeFileSync(path.join(top, "node_modules/x/index.js"), "");
  writeFileSync(path.join(top, "huge.bin"), Buffer.alloc(4096));
  try {
    symlinkSync("/etc/passwd", path.join(top, "src/link"));
  } catch {
    // symlinks need extra rights on Windows; the File-only filter is still exercised by the rest
  }
  const chunks: Buffer[] = [];
  for await (const c of create({ gzip: true, cwd: tmp, portable: true }, ["acme-demo-abc1234"])) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("repository snapshots from GitHub", () => {
  it("unpacks the tarball in memory: files only, no history, dependencies, symlinks or oversized files", async () => {
    const files = await parseTarball(await githubTarball(), { maxFiles: 100, maxBytes: 100_000, maxFileBytes: 1024 });
    expect(files.map((f) => f.path).sort()).toEqual(["package.json", "src/a.ts"]);
    expect(String(files.find((f) => f.path === "src/a.ts")!.content)).toBe("export const a = 1;\n");
    await expect(parseTarball(await githubTarball(), { maxFiles: 1, maxBytes: 100_000, maxFileBytes: 1024 })).rejects.toThrow(/larger than the sandbox limit/);
  });

  it("downloads the tarball for one commit with the given (read-only) client", async () => {
    const archive = await githubTarball();
    const seen: { path: string; auth: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
      return new Response(archive, { status: 200, headers: { "content-type": "application/x-gzip" } });
    }) as typeof globalThis.fetch;
    const octokit = new Octokit({ auth: "ghs_readonly", request: { fetch } });
    const files = await fetchRepoSnapshot(octokit, { owner: "acme", repo: "demo", ref: "abc1234" });
    expect(files.map((f) => f.path).sort()).toEqual(["huge.bin", "package.json", "src/a.ts"]);
    expect(seen).toEqual([{ path: "/repos/acme/demo/tarball/abc1234", auth: "token ghs_readonly" }]);
  });
});
