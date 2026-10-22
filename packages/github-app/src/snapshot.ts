import type { Octokit } from "@octokit/rest";
import { DEFAULT_SNAPSHOT_LIMITS, SNAPSHOT_SKIP, type SnapshotFile, type SnapshotLimits } from "@shapi/sandbox";
import { Parser, type ReadEntry } from "tar";

/**
 * Download a repository at one commit as files in memory, through GitHub's tarball API. Runs
 * outside any sandbox with a short-lived read-only token (see SCAN_PERMISSIONS), so the sandbox
 * gets the code and never a credential. Symlinks and oversized files are left out.
 */
export async function fetchRepoSnapshot(
  octokit: Octokit,
  target: { owner: string; repo: string; ref: string },
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<SnapshotFile[]> {
  const res = await octokit.rest.repos.downloadTarballArchive({ owner: target.owner, repo: target.repo, ref: target.ref });
  return parseTarball(Buffer.from(res.data as ArrayBuffer), limits);
}

/** Files from a GitHub tarball (gzip), with the "<owner>-<repo>-<sha>/" folder stripped. */
export async function parseTarball(archive: Buffer, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  let failure: Error | undefined;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({
      onReadEntry: (entry: ReadEntry) => {
        const rel = entry.path.split("/").slice(1).join("/");
        const skip =
          failure ||
          entry.type !== "File" ||
          !rel ||
          rel.split("/").some((part) => SNAPSHOT_SKIP.has(part) || part === "..") ||
          entry.size > limits.maxFileBytes;
        if (skip) {
          entry.resume();
          return;
        }
        bytes += entry.size;
        if (files.length >= limits.maxFiles || bytes > limits.maxBytes) {
          failure = new Error(`repository is larger than the sandbox limit (${limits.maxFiles} files, ${limits.maxBytes} bytes)`);
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => files.push({ path: rel, content: Buffer.concat(chunks) }));
      },
    });
    parser.on("error", reject);
    parser.on("end", () => resolve());
    parser.end(archive);
  });
  if (failure) throw failure;
  return files;
}
