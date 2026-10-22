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
  /** Files to write in the commit (repo-relative path, full content). */
  files: { path: string; content: string }[];
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
  const key = env.SHAPI_GITHUB_APP_PRIVATE_KEY ?? (env.SHAPI_GITHUB_APP_PRIVATE_KEY_PATH ? readFileSync(env.SHAPI_GITHUB_APP_PRIVATE_KEY_PATH, "utf8") : undefined);
  if (env.SHAPI_GITHUB_APP_ID && env.SHAPI_GITHUB_APP_INSTALLATION_ID && key) {
    return { appId: env.SHAPI_GITHUB_APP_ID, privateKey: key, installationId: Number(env.SHAPI_GITHUB_APP_INSTALLATION_ID) };
  }
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (token) return { token };
  try {
    const fromGh = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fromGh ? { token: fromGh } : undefined;
  } catch {
    return undefined;
  }
}

/** Commit the files on a new branch off the base and open a pull request, using the Git data API (no local clone needed). */
export async function openFixPr(octokit: Octokit, pr: FixPullRequest): Promise<OpenedPullRequest> {
  const { owner, repo } = splitRepo(pr.repo);
  const base = pr.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const commit = await commitOnBase(octokit, owner, repo, base, pr.files, pr.commitMessage);
  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${pr.branch}`, sha: commit });
  } catch (err) {
    if ((err as { status?: number }).status === 422) {
      throw new Error(`branch ${pr.branch} already exists on ${pr.repo}; close or delete the earlier SHAPI PR first`, { cause: err });
    }
    throw err;
  }
  const opened = await octokit.rest.pulls.create({ owner, repo, head: pr.branch, base, title: pr.title, body: pr.body });
  return { url: opened.data.html_url, number: opened.data.number, branch: pr.branch, commit };
}

/** Commit trailer marking a commit as SHAPI's own; a branch whose head lacks it was edited by someone else. */
export const FIX_TRAILER = "SHAPI-Branch";

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
  const message = `${pr.commitMessage.trimEnd()}\n\n${FIX_TRAILER}: ${pr.branch}`;
  const { data: prs } = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${pr.branch}`, state: "all", sort: "created", direction: "desc", per_page: 10 });
  const openPr = prs.find((p) => p.state === "open");
  const latest = prs[0];
  const closedByMaintainer = !openPr && latest && !latest.merged_at;
  if (closedByMaintainer && !pr.retryClosed) {
    return { action: "skipped", reason: "closed without merging", branch: pr.branch, url: latest.html_url, number: latest.number, state: "closed" };
  }

  const head = await branchHead(octokit, owner, repo, pr.branch);
  const ours = head ? (await octokit.rest.git.getCommit({ owner, repo, commit_sha: head })).data.message.includes(`${FIX_TRAILER}: ${pr.branch}`) : true;

  if (openPr) {
    const found = { branch: pr.branch, url: openPr.html_url, number: openPr.number, state: "open" as const };
    if (openPr.labels.some((l) => l.name === STOP_LABEL)) return { action: "skipped", reason: `labeled ${STOP_LABEL}`, ...found };
    if (!ours) return { action: "skipped", reason: "someone else pushed to the branch", ...found };
    if (head && (await filesMatch(octokit, owner, repo, head, pr.files))) {
      if (openPr.title !== pr.title || (openPr.body ?? "") !== pr.body) {
        await octokit.rest.pulls.update({ owner, repo, pull_number: openPr.number, title: pr.title, body: pr.body });
      }
      return { action: "unchanged", url: openPr.html_url, number: openPr.number, branch: pr.branch, commit: head };
    }
    const commit = await commitOnBase(octokit, owner, repo, openPr.base.ref, pr.files, message);
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${pr.branch}`, sha: commit, force: true });
    await octokit.rest.pulls.update({ owner, repo, pull_number: openPr.number, title: pr.title, body: pr.body });
    return { action: "updated", url: openPr.html_url, number: openPr.number, branch: pr.branch, commit };
  }

  // A leftover branch is reused only if it is SHAPI's own or its PR was merged.
  if (head && !ours && !latest?.merged_at && !closedByMaintainer) return { action: "skipped", reason: "a branch with this name exists and is not SHAPI's", branch: pr.branch };
  const base = pr.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const commit = await commitOnBase(octokit, owner, repo, base, pr.files, message);
  if (head) await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${pr.branch}`, sha: commit, force: true });
  else await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${pr.branch}`, sha: commit });
  const opened = await octokit.rest.pulls.create({ owner, repo, head: pr.branch, base, title: pr.title, body: pr.body });
  if (pr.labels?.length) await octokit.rest.issues.addLabels({ owner, repo, issue_number: opened.data.number, labels: pr.labels });
  return { action: "created", url: opened.data.html_url, number: opened.data.number, branch: pr.branch, commit };
}

function splitRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`repo must be owner/name, got ${full}`);
  return { owner, repo };
}

async function branchHead(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string | undefined> {
  try {
    return (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })).data.object.sha;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

/** Commit `files` on top of the base branch's head; returns the new commit's sha. */
async function commitOnBase(octokit: Octokit, owner: string, repo: string, base: string, files: FixPullRequest["files"], message: string): Promise<string> {
  const baseSha = (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha;
  const baseTree = (await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha })).data.tree.sha;

  // Keep each existing file's line endings: a Windows checkout (CRLF) must not rewrite every line of an LF file.
  const existing = new Set(
    (await octokit.rest.git.getTree({ owner, repo, tree_sha: baseTree, recursive: "true" })).data.tree.map((e) => e.path),
  );
  const contents = await Promise.all(
    files.map(async (f) => ({
      ...f,
      content: existing.has(f.path) ? await matchLineEndings(octokit, owner, repo, base, f.path, f.content) : f.content.replace(/\r\n/g, "\n"),
    })),
  );
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: contents.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content })),
  });
  const commit = await octokit.rest.git.createCommit({ owner, repo, message, tree: tree.data.sha, parents: [baseSha] });
  return commit.data.sha;
}

async function readFile(octokit: Octokit, owner: string, repo: string, ref: string, filePath: string): Promise<string | undefined> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
    return !Array.isArray(res.data) && res.data.type === "file" && "content" in res.data ? Buffer.from(res.data.content, "base64").toString("utf8") : undefined;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

/** Whether the branch already holds exactly these files (line endings aside). */
async function filesMatch(octokit: Octokit, owner: string, repo: string, ref: string, files: FixPullRequest["files"]): Promise<boolean> {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  for (const f of files) {
    const current = await readFile(octokit, owner, repo, ref, f.path);
    if (current === undefined || lf(current) !== lf(f.content)) return false;
  }
  return true;
}

/** Convert `content` to the line endings of the existing file on the base branch. */
async function matchLineEndings(octokit: Octokit, owner: string, repo: string, ref: string, filePath: string, content: string): Promise<string> {
  const current = (await readFile(octokit, owner, repo, ref, filePath)) ?? "";
  const lf = content.replace(/\r\n/g, "\n");
  return current.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
}

/** "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" → "owner/name". */
export function repoFromUrl(url: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
