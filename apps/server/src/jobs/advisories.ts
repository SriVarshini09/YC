import { AdvisorySchema, loadAdvisories, type Advisory } from "@shapi/core";
import { upsertAdvisories, type Db } from "@shapi/db";
import { createOctokit, fetchRepoSnapshot } from "@shapi/github-app";

/** Load the reviewed advisories shipped in the advisories/ folder into the database. Safe to run on every start. */
export async function syncAdvisoriesJob(db: Db, dir: string): Promise<number> {
  return upsertAdvisories(db, loadAdvisories(dir), { reviewed: true, source: "repo" });
}

export interface RepoSyncResult {
  written: number;
  advisories: number;
  /** Files that are not valid advisories; they are skipped, the rest still sync. */
  invalid: { file: string; error: string }[];
}

/**
 * Sync the reviewed advisories from the public advisory repository (for example
 * SriVarshini09/shapi-advisories): every `advisories/*.json` at the default branch. No token is
 * needed for a public repository. A file that fails validation is reported and skipped, so one bad
 * file cannot block the others; unchanged advisories are not rewritten.
 */
export async function syncAdvisoriesFromGitHub(db: Db, repoFullName: string, opts: { fetch?: typeof globalThis.fetch; ref?: string } = {}): Promise<RepoSyncResult> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`advisory repository must be owner/name, got ${repoFullName}`);
  const files = await fetchRepoSnapshot(createOctokit({}, { fetch: opts.fetch }), { owner, repo, ref: opts.ref ?? "main" });
  const advisories: Advisory[] = [];
  const invalid: RepoSyncResult["invalid"] = [];
  for (const f of files.filter((f) => /^advisories\/[^/]+\.json$/.test(f.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    try {
      const parsed = AdvisorySchema.safeParse(JSON.parse(String(f.content)));
      if (parsed.success) advisories.push(parsed.data);
      else invalid.push({ file: f.path, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    } catch (err) {
      invalid.push({ file: f.path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!advisories.length) throw new Error(`no valid advisories found in ${repoFullName}`);
  const written = await upsertAdvisories(db, advisories, { reviewed: true, source: `github:${repoFullName}` });
  return { written, advisories: advisories.length, invalid };
}
