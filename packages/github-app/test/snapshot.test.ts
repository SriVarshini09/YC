import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
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
  writeFileSync(path.join(top, "pnpm-lock.yaml"), `lockfileVersion: '9.0'\n${"#".repeat(4096)}`);
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
    // An oversized lockfile is kept: without it the install picks the wrong package manager.
    expect(files.map((f) => f.path).sort()).toEqual(["package.json", "pnpm-lock.yaml", "src/a.ts"]);
    expect(String(files.find((f) => f.path === "src/a.ts")!.content)).toBe("export const a = 1;\n");
    await expect(parseTarball(await githubTarball(), { maxFiles: 1, maxBytes: 100_000, maxFileBytes: 1024 })).rejects.toThrow(/larger than the sandbox limit/);
  });

  it("unpacks the download as it streams in, and stops reading it once a limit is hit", async () => {
    const top = path.join(tmp, "acme-big-abc1234");
    mkdirSync(top, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(path.join(top, `f${i}.bin`), randomBytes(20_000));
    const chunks: Buffer[] = [];
    for await (const c of create({ gzip: true, cwd: tmp, portable: true }, ["acme-big-abc1234"])) chunks.push(c as Buffer);
    const archive = Buffer.concat(chunks);
    let pulled = 0;
    const stream = () => {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= archive.length) return controller.close();
          const chunk = archive.subarray(offset, offset + 16_384);
          offset += chunk.length;
          pulled += chunk.length;
          controller.enqueue(chunk);
        },
      });
    };
    const fetch = (async () => new Response(stream(), { status: 200, headers: { "content-type": "application/x-gzip" } })) as typeof globalThis.fetch;
    const octokit = new Octokit({ auth: "t", request: { fetch } });
    await expect(fetchRepoSnapshot(octokit, { owner: "acme", repo: "big", ref: "abc1234" }, { maxFiles: 3, maxBytes: 10_000_000, maxFileBytes: 100_000 })).rejects.toThrow(/larger than the sandbox limit/);
    expect(pulled).toBeLessThan(archive.length / 2);

    pulled = 0;
    const all = await fetchRepoSnapshot(octokit, { owner: "acme", repo: "big", ref: "abc1234" }, { maxFiles: 100, maxBytes: 10_000_000, maxFileBytes: 100_000 });
    expect(all).toHaveLength(40);
    expect(pulled).toBe(archive.length);
  });

  it("rejects a corrupt download without an unhandled rejection, and stops reading it", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", record);
    try {
      // A gzip header, then garbage: the parser fails while the download is still being read.
      const chunks = [gzipSync(Buffer.alloc(4096, 0x41)).subarray(0, 20), Buffer.from("garbage-garbage-garbage-garbage-garbage"), ...Array.from({ length: 20 }, () => Buffer.alloc(100, 1))];
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 20));
          if (pulled < chunks.length) controller.enqueue(new Uint8Array(chunks[pulled++]!));
          else controller.close();
        },
      });
      await expect(parseTarball(stream)).rejects.toThrow(/zlib/i);
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
      expect(pulled).toBeLessThan(chunks.length);
    } finally {
      process.off("unhandledRejection", record);
    }
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
    expect(files.map((f) => f.path).sort()).toEqual(["huge.bin", "package.json", "pnpm-lock.yaml", "src/a.ts"]);
    expect(seen).toEqual([{ path: "/repos/acme/demo/tarball/abc1234", auth: "token ghs_readonly" }]);
  });
});
