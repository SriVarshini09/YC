import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiLock, matchAdvisories, type Advisory, type MatchResult } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { verdictFor, type Verdict } from "./metrics";

export interface ScanCommitInput {
  /** `owner/name`. */
  repo: string;
  sha: string;
  advisoryId: string;
  advisories: Advisory[];
  /** A GitHub token: tarball downloads are rate-limited without one. */
  token?: string;
  /** Larger archives are not scanned. */
  maxBytes?: number;
  now?: Date;
  fetch?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;

/**
 * Download a repository at one commit, scan it with SHAPI's extractor and matcher, and return the
 * verdict for one advisory. Static analysis only: nothing in the repository is run.
 */
export async function scanCommit(input: ScanCommitInput): Promise<Verdict> {
  return verdictFor((await scanRepo(input)).match, input.advisoryId);
}

/** As scanCommit, for every advisory: the call sites SHAPI found and the whole match. */
export async function scanRepo(input: Omit<ScanCommitInput, "advisoryId">): Promise<{ callSites: number; match: MatchResult }> {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(input.repo)) throw new Error(`not owner/name: ${input.repo}`);
  if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new Error(`not a commit sha: ${input.sha}`);
  const body = await download(input);
  if (body.length > (input.maxBytes ?? DEFAULT_MAX_BYTES)) throw new Error(`archive is ${Math.round(body.length / 1048576)} MB, over the limit`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-bench-"));
  try {
    const archive = path.join(dir, "repo.tgz");
    const root = path.join(dir, "repo");
    writeFileSync(archive, body);
    mkdirSync(root);
    // Relative paths keep Windows drive letters away from tar, which would read them as remote hosts.
    try {
      execFileSync("tar", ["-xzf", "repo.tgz", "-C", "repo", "--strip-components=1"], { cwd: dir, stdio: "ignore" });
    } catch (err) {
      // Some entries cannot be created on this file system (a name Windows forbids, a symlink); the rest are scanned.
      if (readdirSync(root).length === 0) throw err;
    }
    const lock = createApiLock(extractCallSites(root), "shapi-bench");
    return { callSites: lock.callSites.length, match: matchAdvisories(lock, input.advisories, { now: input.now ?? new Date() }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The repository archive at the commit, retried twice on network errors and 5xx answers. */
async function download(input: Omit<ScanCommitInput, "advisoryId">): Promise<Buffer> {
  const doFetch = input.fetch ?? fetch;
  const url = `https://api.github.com/repos/${input.repo}/tarball/${input.sha}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(input.token ? { authorization: `Bearer ${input.token}` } : {}) };
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await doFetch(url, { headers });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status < 500) throw Object.assign(new Error(`download failed: ${res.status}`), { final: true });
      last = new Error(`download failed: ${res.status}`);
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;
      last = err;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw last instanceof Error ? last : new Error(String(last));
}
