import type { Octokit } from "@octokit/rest";
import { DEFAULT_SNAPSHOT_LIMITS, SNAPSHOT_SKIP, type SnapshotFile, type SnapshotLimits } from "@shapi/sandbox";
import { Parser, type ReadEntry } from "tar";

/**
 * Download a repository at one commit as files in memory, through GitHub's tarball API. Runs
 * outside any sandbox with a short-lived read-only token (see SCAN_PERMISSIONS), so the sandbox
 * gets the code and never a credential. Symlinks and oversized files are left out. The archive is
 * unpacked as it downloads, so only the kept files are held in memory, and the download stops at a limit.
 */
export async function fetchRepoSnapshot(
  octokit: Octokit,
  target: { owner: string; repo: string; ref: string },
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): Promise<SnapshotFile[]> {
  const res = await octokit.rest.repos.downloadTarballArchive({ owner: target.owner, repo: target.repo, ref: target.ref, request: { parseSuccessResponseBody: false } });
  return parseTarball(res.data as unknown as ReadableStream<Uint8Array>, limits);
}

/** Files from a GitHub tarball (gzip, whole or as a stream), with the "<owner>-<repo>-<sha>/" folder stripped. */
export async function parseTarball(archive: Buffer | ReadableStream<Uint8Array>, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  let failure: Error | undefined;
  let parser!: Parser;
  const parsed = new Promise<void>((resolve, reject) => {
    parser = new Parser({
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
  });
  if (Buffer.isBuffer(archive)) parser.end(archive);
  else {
    const reader = archive.getReader();
    for (;;) {
      if (failure) {
        // Over a limit: stop downloading rather than read the rest of the archive.
        await reader.cancel().catch(() => undefined);
        parsed.catch(() => undefined);
        throw failure;
      }
      const { done, value } = await reader.read();
      if (done) break;
      parser.write(Buffer.from(value));
    }
    parser.end();
  }
  await parsed;
  if (failure) throw failure;
  return files;
}
