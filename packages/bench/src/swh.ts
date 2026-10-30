/**
 * Software Heritage, the public archive of source code (archive.softwareheritage.org), as the benchmark's mirror
 * (execution plan P-07). A git commit's SWHID is its sha (swh:1:rev:<sha>), so every instance has a permanent
 * address there once its repository has been archived, even if the repository is later deleted from GitHub.
 */
const API = "https://archive.softwareheritage.org/api/1";

/** The page for a commit in Software Heritage, with the repository it came from. */
export function mirrorUrl(repo: string, sha: string): string {
  return `https://archive.softwareheritage.org/swh:1:rev:${sha};origin=https://github.com/${repo}`;
}

export interface SwhOptions {
  fetch?: typeof fetch;
  /** How long to wait for Software Heritage to prepare an archive. */
  timeoutMs?: number;
  /** Between checks while it prepares one. */
  pollMs?: number;
}

const headers = { accept: "application/json", "user-agent": "shapi-bench" };

/** Whether Software Heritage holds the commit. */
export async function swhHasCommit(sha: string, opts: SwhOptions = {}): Promise<boolean> {
  const res = await (opts.fetch ?? fetch)(`${API}/revision/${sha}/`, { headers });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Software Heritage: revision ${sha}: ${res.status}`);
  return true;
}

/**
 * The commit's files as a .tar.gz from Software Heritage's vault. The vault prepares the archive on request
 * ("cooking"), which can take minutes, so this is the fallback for a commit GitHub no longer serves.
 * The archive holds one top folder, like GitHub's tarballs.
 */
export async function swhTarball(sha: string, opts: SwhOptions = {}): Promise<Buffer> {
  const doFetch = opts.fetch ?? fetch;
  const json = async (res: Response, what: string) => {
    if (!res.ok) throw new Error(`Software Heritage: ${what}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  const revision = await json(await doFetch(`${API}/revision/${sha}/`, { headers }), `revision ${sha}`);
  const dir = String(revision.directory);
  if (!/^[0-9a-f]{40}$/.test(dir)) throw new Error(`Software Heritage: revision ${sha} has no directory`);
  const cook = `${API}/vault/flat/swh:1:dir:${dir}/`;
  let state = await json(await doFetch(cook, { method: "POST", headers }), `vault ${dir}`);
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  while (state.status !== "done") {
    if (state.status === "failed") throw new Error(`Software Heritage: the vault could not prepare ${dir}: ${String(state.progress_message ?? "")}`);
    if (Date.now() > deadline) throw new Error(`Software Heritage: the vault did not prepare ${dir} in time`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 10_000));
    state = await json(await doFetch(cook, { headers }), `vault ${dir}`);
  }
  const res = await doFetch(String(state.fetch_url), { headers: { "user-agent": headers["user-agent"] } });
  if (!res.ok) throw new Error(`Software Heritage: download ${dir}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
