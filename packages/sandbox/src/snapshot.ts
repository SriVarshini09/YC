import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SnapshotFile } from "./types";

/** Never copied into a sandbox: history, dependencies (installed fresh inside), build output, local state. */
export const SNAPSHOT_SKIP = new Set([".git", "node_modules", "dist", "coverage", ".shapi", ".next", ".turbo"]);

export interface SnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  /** Larger single files (assets, dumps) are left out. */
  maxFileBytes: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { maxFiles: 20_000, maxBytes: 200 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024 };

/** Read a local checkout into a snapshot, within limits. Fails rather than silently dropping part of a repo that is too big. */
export function readSnapshot(dir: string, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SNAPSHOT_SKIP.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const size = statSync(path.join(dir, child)).size;
        if (size > limits.maxFileBytes) continue;
        bytes += size;
        if (files.length >= limits.maxFiles || bytes > limits.maxBytes) throw new Error(`repository is larger than the sandbox limit (${limits.maxFiles} files, ${limits.maxBytes} bytes)`);
        files.push({ path: child, content: readFileSync(path.join(dir, child)) });
      }
    }
  };
  walk("");
  return files;
}
