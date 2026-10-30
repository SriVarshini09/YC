import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAdvisories } from "@shapi/core";
import { loadPythonParser } from "@shapi/extractor";
import { mirrorUrl, scanCommit, swhHasCommit, swhTarball, type Dataset } from "@shapi/bench";

const benchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisories = loadAdvisories(path.join(benchRoot, "..", "..", "advisories"));
const sha = "a".repeat(40);
const dir = "d".repeat(40);
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-swh-"));
beforeAll(() => loadPythonParser());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A .tar.gz with one top folder holding a file that checks GitHub's old 204, as Software Heritage's vault returns it. */
async function tarball(): Promise<Buffer> {
  const top = path.join(tmp, `swh_1_dir_${dir}`);
  mkdirSync(top, { recursive: true });
  writeFileSync(
    path.join(top, "dispatch.py"),
    'import requests\nr = requests.post("https://api.github.com/repos/acme/web/actions/workflows/ci.yml/dispatches", json={"ref": "main"})\nif r.status_code == 204:\n    print("ok")\n',
  );
  const file = path.join(tmp, "bundle.tgz");
  await create({ gzip: true, file, cwd: tmp }, [`swh_1_dir_${dir}`]);
  return readFileSync(file);
}

/** GitHub has lost the commit; Software Heritage has it and cooks it on the second check. */
function fakes(bundle: Buffer) {
  const calls: string[] = [];
  let checks = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("https://api.github.com/")) return new Response("Not Found", { status: 404 });
    if (url.endsWith(`/revision/${sha}/`)) return Response.json({ id: sha, directory: dir });
    if (url.endsWith(`/vault/flat/swh:1:dir:${dir}/`)) {
      checks++;
      return Response.json(checks < 2 ? { status: "pending" } : { status: "done", fetch_url: `https://archive.softwareheritage.org/api/1/vault/flat/swh:1:dir:${dir}/raw/` });
    }
    if (url.endsWith("/raw/")) return new Response(new Uint8Array(bundle));
    return new Response("unexpected", { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Software Heritage mirror (P-07)", () => {
  it("names a commit's permanent page by its SWHID and origin", () => {
    expect(mirrorUrl("acme/web", sha)).toBe(`https://archive.softwareheritage.org/swh:1:rev:${sha};origin=https://github.com/acme/web`);
  });

  it("tells whether it holds a commit", async () => {
    const fetch = (async (input: string | URL | Request) => new Response("{}", { status: String(input).includes(sha) ? 200 : 404 })) as typeof globalThis.fetch;
    expect(await swhHasCommit(sha, { fetch })).toBe(true);
    expect(await swhHasCommit("b".repeat(40), { fetch })).toBe(false);
  });

  it("prepares and downloads a commit's files from the vault", async () => {
    const bundle = await tarball();
    const { fetch, calls } = fakes(bundle);
    expect((await swhTarball(sha, { fetch, pollMs: 1 })).equals(bundle)).toBe(true);
    expect(calls.filter((c) => c.includes("/vault/"))).toEqual([
      `POST https://archive.softwareheritage.org/api/1/vault/flat/swh:1:dir:${dir}/`,
      `GET https://archive.softwareheritage.org/api/1/vault/flat/swh:1:dir:${dir}/`,
      `GET https://archive.softwareheritage.org/api/1/vault/flat/swh:1:dir:${dir}/raw/`,
    ]);
  });

  it("scans a commit GitHub deleted from its Software Heritage copy, and only when the mirror is on", async () => {
    const { fetch } = fakes(await tarball());
    const input = { repo: "acme/web", sha, advisoryId: "github-workflow-dispatch-204-to-200", advisories, fetch };
    await expect(scanCommit(input)).rejects.toThrow("download failed: 404");
    expect(await scanCommit({ ...input, mirror: { pollMs: 1 } })).toBe("affected");
  }, 60_000);

  it("records a mirror for every benchmark instance", () => {
    const dataset = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "apibreak-v0.json"), "utf8")) as Dataset;
    const mirrors = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "apibreak-v0.mirrors.json"), "utf8")) as {
      instances: { id: string; repo: string; fixCommit: string; mirror: string; archived: boolean }[];
    };
    expect(mirrors.instances.map((m) => m.id)).toEqual(dataset.instances.map((i) => i.id));
    for (const m of mirrors.instances) expect(m.mirror).toBe(mirrorUrl(m.repo, m.fixCommit));
  });
});
