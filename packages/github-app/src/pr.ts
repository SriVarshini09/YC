import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { STOP_LABEL } from "./policy";

/** A personal or gh token now; a GitHub App installation later (same delivery code). */
export type GitHubAuth = { token: string } | { appId: string; privateKey: string; installationId: number };

export interface FixPullRequest {
  /** "owner/name" */
  repo: string;
  /** Head branch to create, for example "shapi/github-workflow-dispatch-204-to-200". */
  branch: string;
  /** Base branch; defaults to the repo's default branch. */
  base?: string;
  title: string;
  body: string;
  commitMessage: string;
  /**
   * Files to write in the commit (repo-relative path, full content). `before` is the content the fix
   * was computed from ("" for a new file): when it is set and the file on the parent commit differs,
   * the commit is refused, because writing the whole file would revert that difference.
   */
  files: { path: string; content: string; before?: string }[];
  /**
   * The commit the files were computed from (the scanned sha). The fix commit is built on it, so the
   * PR merges with (or conflicts with) whatever the base gained since, and never reverts it. Without
   * it the fix goes on the base branch's current head.
   */
  baseSha?: string;
}

export interface OpenedPullRequest {
  url: string;
  number: number;
  branch: string;
  commit: string;
}

export function octokitFor(auth: GitHubAuth, opts: { fetch?: typeof globalThis.fetch } = {}): Octokit {
  const request = opts.fetch ? { fetch: opts.fetch } : undefined;
  if ("token" in auth) return new Octokit({ auth: auth.token, userAgent: "shapi", request });
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: auth.appId, privateKey: auth.privateKey, installationId: auth.installationId },
    userAgent: "shapi",
    request,
  });
}

/**
 * Credentials from the environment: a GitHub App when SHAPI_GITHUB_APP_ID,
 * SHAPI_GITHUB_APP_INSTALLATION_ID and SHAPI_GITHUB_APP_PRIVATE_KEY (or _PATH)
 * are set; otherwise GITHUB_TOKEN / GH_TOKEN; otherwise the gh CLI login.
 */
export function authFromEnv(env: Record<string, string | undefined> = process.env): GitHubAuth | undefined {
  if (env.SHAPI_GITHUB_APP_ID && env.SHAPI_GITHUB_APP_INSTALLATION_ID) {
    // The key file is read only when the App is configured: a stale _PATH must not break token auth.
    const key = env.SHAPI_GITHUB_APP_PRIVATE_KEY || (env.SHAPI_GITHUB_APP_PRIVATE_KEY_PATH ? readFileSync(env.SHAPI_GITHUB_APP_PRIVATE_KEY_PATH, "utf8") : undefined);
    if (key) return { appId: env.SHAPI_GITHUB_APP_ID, privateKey: key, installationId: Number(env.SHAPI_GITHUB_APP_INSTALLATION_ID) };
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) return { token };
  try {
    const fromGh = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fromGh ? { token: fromGh } : undefined;
  } catch {
    return undefined;
  }
}

/** Commit trailer marking a commit as SHAPI's own; a branch whose head lacks it was edited by someone else. */
export const FIX_TRAILER = "SHAPI-Branch";

/** Commit trailer naming the tree SHAPI committed: an amended or squashed commit that kept the message has another tree. */
export const TREE_TRAILER = "SHAPI-Tree";

export interface UpsertFixPullRequest extends FixPullRequest {
  /** Labels for a newly opened PR. */
  labels?: string[];
  /** A maintainer asked (from the dashboard) to open a fix they closed again. */
  retryClosed?: boolean;
}

export type FixPrOutcome =
  | { action: "created" | "updated" | "unchanged"; url: string; number: number; branch: string; commit: string }
  | { action: "skipped"; reason: string; branch: string; url?: string; number?: number; state?: "open" | "closed" };

/**
 * Open the fix PR, or bring the existing one up to date, keyed by its deterministic branch. A rerun
 * with the same fix changes nothing; a changed fix is regenerated on the current base and force-pushed
 * (as Renovate does), unless the PR has the stop label or someone else pushed to the branch. A PR a
 * maintainer closed without merging stays closed. A merged fix frees the branch for a new PR.
 */
export async function upsertFixPr(octokit: Octokit, pr: UpsertFixPullRequest): Promise<FixPrOutcome> {
  const { owner, repo } = splitRepo(pr.repo);
  const message = (tree: string) => `${pr.commitMessage.trimEnd()}\n\n${FIX_TRAILER}: ${pr.branch}\n${TREE_TRAILER}: ${tree}`;
  const { data: prs } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${pr.branch}`, state: "all", sort: "created", direction: "desc", per_page: 10 });
  const openPr = prs.find((p) => p.state === "open");
  const latest = prs[0];
  const closedByMaintainer = !openPr && latest && !latest.merged_at;
  if (closedByMaintainer && !pr.retryClosed) {
    return { action: "skipped", reason: "closed without merging", branch: pr.branch, url: latest.html_url, number: latest.number, state: "closed" };
  }

  const head = await branchHead(octokit, owner, repo, pr.branch);
  const headCommit = head ? (await octokit.rest.git.getCommit({ owner, repo, commit_sha: head })).data : undefined;
  const ours = !headCommit || isOurs(headCommit, pr.branch);

  if (openPr) {
    const found = { branch: pr.branch, url: openPr.html_url, number: openPr.number, state: "open" as const };
    if (openPr.labels.some((l) => l.name === STOP_LABEL)) return { action: "skipped", reason: `labeled ${STOP_LABEL}`, ...found };
    if (!ours) return { action: "skipped", reason: "someone else pushed to the branch", ...found };
    // A PR that conflicts with its base is regenerated even when the fix itself is unchanged, unless it already
    // sits on the commit this fix was computed from (regenerating would rebuild the same conflict).
    const conflicted = (await octokit.rest.pulls.get({ owner, repo, pull_number: openPr.number })).data.mergeable === false;
    const sameParent = pr.baseSha !== undefined && headCommit?.parents[0]?.sha === pr.baseSha;
    if (head && headCommit && (!conflicted || sameParent) && (await filesMatch(octokit, owner, repo, headCommit.tree.sha, pr.files))) {
      if (openPr.title !== pr.title || (openPr.body ?? "") !== pr.body) {
        await octokit.rest.pulls.update({ owner, repo, pull_number: openPr.number, title: pr.title, body: pr.body });
      }
      return { action: "unchanged", url: openPr.html_url, number: openPr.number, branch: pr.branch, commit: head };
    }
    const commit = await commitFix(octokit, owner, repo, pr.baseSha ?? (await branchSha(octokit, owner, repo, openPr.base.ref)), pr.files, message);
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${pr.branch}`, sha: commit, force: true });
    await octokit.rest.pulls.update({ owner, repo, pull_number: openPr.number, title: pr.title, body: pr.body });
    return { action: "updated", url: openPr.html_url, number: openPr.number, branch: pr.branch, commit };
  }

  // A leftover branch is reused only if its head is SHAPI's own commit: never force-push over someone's work,
  // not even after a merge or when a maintainer asked to retry a closed fix.
  if (head && !ours) {
    if (closedByMaintainer) return { action: "skipped", reason: "someone else pushed to the branch", branch: pr.branch, url: latest.html_url, number: latest.number, state: "closed" };
    return { action: "skipped", reason: "a branch with this name exists and is not SHAPI's", branch: pr.branch };
  }
  const base = pr.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const commit = await commitFix(octokit, owner, repo, pr.baseSha ?? (await branchSha(octokit, owner, repo, base)), pr.files, message);
  if (head) await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${pr.branch}`, sha: commit, force: true });
  else await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${pr.branch}`, sha: commit });
  const opened = await octokit.rest.pulls.create({ owner, repo, head: pr.branch, base, title: pr.title, body: pr.body });
  if (pr.labels?.length) await octokit.rest.issues.addLabels({ owner, repo, issue_number: opened.data.number, labels: pr.labels });
  return { action: "created", url: opened.data.html_url, number: opened.data.number, branch: pr.branch, commit };
}

/** Whether a branch head is the commit SHAPI made: its trailer names the branch, and its tree is the one SHAPI committed. */
function isOurs(commit: { message: string; tree: { sha: string } }, branch: string): boolean {
  if (!commit.message.includes(`${FIX_TRAILER}: ${branch}`)) return false;
  const tree = new RegExp(`^${TREE_TRAILER}: (\\S+)$`, "m").exec(commit.message)?.[1];
  // Commits made before the tree trailer existed carry only the branch trailer.
  return tree === undefined || tree === commit.tree.sha;
}

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`repo must be owner/name, got ${full}`);
  return { owner, repo };
}

/** The branch's head commit, or undefined. Uses matching-refs, which answers [] rather than a 404 for a new branch. */
async function branchHead(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string | undefined> {
  const { data } = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: `heads/${branch}` });
  return data.find((r) => r.ref === `refs/heads/${branch}`)?.object.sha;
}

async function branchSha(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string> {
  return (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
}

/** Commit `files` on top of `parent`; returns the new commit's sha. `message` is given the new tree's sha. */
async function commitFix(octokit: Octokit, owner: string, repo: string, parent: string, files: FixPullRequest["files"], message: (tree: string) => string): Promise<string> {
  const parentTree = (await octokit.rest.git.getCommit({ owner, repo, commit_sha: parent })).data.tree.sha;
  const entries = [];
  for (const f of files) {
    const current = await readEntry(octokit, owner, repo, parentTree, f.path);
    if (f.before !== undefined && lf(current?.content ?? "") !== lf(f.before)) {
      throw new Error(`${f.path} on ${owner}/${repo} differs from the code the fix was computed from; update your checkout and run the fix again`);
    }
    // Keep each existing file's line endings (a Windows checkout must not rewrite every line of an LF file) and its executable bit.
    const content = current?.content.includes("\r\n") ? lf(f.content).replace(/\n/g, "\r\n") : lf(f.content);
    entries.push({ path: f.path, mode: current?.mode === "100755" ? ("100755" as const) : ("100644" as const), type: "blob" as const, content });
  }
  const tree = await octokit.rest.git.createTree({ owner, repo, base_tree: parentTree, tree: entries });
  const commit = await octokit.rest.git.createCommit({ owner, repo, message: message(tree.data.sha), tree: tree.data.sha, parents: [parent] });
  return commit.data.sha;
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");

/**
 * The file at `filePath` in a tree, with its mode, or undefined. Walks one directory at a time (a
 * recursive listing is truncated in big repositories) and reads the blob (the contents API returns
 * no content for files over 1 MB).
 */
async function readEntry(octokit: Octokit, owner: string, repo: string, treeSha: string, filePath: string): Promise<{ mode: string; content: string } | undefined> {
  const parts = filePath.split("/");
  let sha = treeSha;
  for (const [i, name] of parts.entries()) {
    const entry = (await octokit.rest.git.getTree({ owner, repo, tree_sha: sha })).data.tree.find((e) => e.path === name);
    const last = i === parts.length - 1;
    if (!entry?.sha || entry.type !== (last ? "blob" : "tree")) return undefined;
    sha = entry.sha;
    if (last) {
      const blob = (await octokit.rest.git.getBlob({ owner, repo, file_sha: sha })).data;
      return { mode: entry.mode ?? "100644", content: Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8") };
    }
  }
  return undefined;
}

/** Whether the tree already holds exactly these files (line endings aside). */
async function filesMatch(octokit: Octokit, owner: string, repo: string, treeSha: string, files: FixPullRequest["files"]): Promise<boolean> {
  for (const f of files) {
    const current = await readEntry(octokit, owner, repo, treeSha, f.path);
    if (current === undefined || lf(current.content) !== lf(f.content)) return false;
  }
  return true;
}

/** "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" → "owner/name". */
export function repoFromUrl(url: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
