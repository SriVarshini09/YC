import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

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
  const [owner, repo] = pr.repo.split("/") as [string, string];
  if (!owner || !repo) throw new Error(`repo must be owner/name, got ${pr.repo}`);
  const base = pr.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
  const baseSha = (await octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha;
  const baseTree = (await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha })).data.tree.sha;

  // Keep each existing file's line endings: a Windows checkout (CRLF) must not rewrite every line of an LF file.
  const existing = new Set(
    (await octokit.rest.git.getTree({ owner, repo, tree_sha: baseTree, recursive: "true" })).data.tree.map((e) => e.path),
  );
  const files = await Promise.all(
    pr.files.map(async (f) => ({
      ...f,
      content: existing.has(f.path) ? await matchLineEndings(octokit, owner, repo, base, f.path, f.content) : f.content.replace(/\r\n/g, "\n"),
    })),
  );
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content })),
  });
  const commit = await octokit.rest.git.createCommit({ owner, repo, message: pr.commitMessage, tree: tree.data.sha, parents: [baseSha] });

  try {
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${pr.branch}`, sha: commit.data.sha });
  } catch (err) {
    if ((err as { status?: number }).status === 422) {
      throw new Error(`branch ${pr.branch} already exists on ${pr.repo}; close or delete the earlier SHAPI PR first`, { cause: err });
    }
    throw err;
  }
  const opened = await octokit.rest.pulls.create({ owner, repo, head: pr.branch, base, title: pr.title, body: pr.body });
  return { url: opened.data.html_url, number: opened.data.number, branch: pr.branch, commit: commit.data.sha };
}

/** Convert `content` to the line endings of the existing file on the base branch. */
async function matchLineEndings(octokit: Octokit, owner: string, repo: string, ref: string, filePath: string, content: string): Promise<string> {
  const res = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
  const current = !Array.isArray(res.data) && res.data.type === "file" && "content" in res.data ? Buffer.from(res.data.content, "base64").toString("utf8") : "";
  const lf = content.replace(/\r\n/g, "\n");
  return current.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
}

/** "https://github.com/owner/name(.git)" or "git@github.com:owner/name.git" → "owner/name". */
export function repoFromUrl(url: string): string | undefined {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}
