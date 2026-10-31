import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";

/**
 * Active committers (execution plan I-03): who committed to a private repository in the last 90 days, the unit SHAPI's
 * plan counts. Each is kept as a hash of their GitHub login, or of the commit's author email when the commit isn't
 * linked to an account, salted with the account id: the count is all SHAPI needs, never who they are. Bots don't count.
 */
export const COMMITTER_WINDOW_DAYS = 90;
/** Pages of 100 commits read per repository: a repository busier than this counts the committers of its newest 1,000. */
export const MAX_COMMIT_PAGES = 10;

interface CommitItem {
  author?: { login?: string; type?: string } | null;
  commit?: { author?: { email?: string } | null };
}

const isBot = (c: CommitItem) => c.author?.type === "Bot" || /\[bot\]$/i.test(c.author?.login ?? "") || /^\d+\+[^@]+\[bot\]@users\.noreply\.github\.com$/i.test(c.commit?.author?.email ?? "");

/** The committer hashes of a set of commits. */
export function committerHashes(accountId: string, commits: CommitItem[]): string[] {
  const out = new Set<string>();
  for (const c of commits) {
    if (isBot(c)) continue;
    const identity = c.author?.login ? `login:${c.author.login.toLowerCase()}` : c.commit?.author?.email ? `email:${c.commit.author.email.toLowerCase()}` : undefined;
    if (identity) out.add(createHash("sha256").update(`${accountId}:${identity}`).digest("hex").slice(0, 32));
  }
  return [...out].sort();
}

/** Read a repository's commits of the last 90 days on its default branch and hash who made them. */
export async function countCommitters(octokit: Pick<Octokit, "request">, input: { owner: string; repo: string; accountId: string; now: Date }): Promise<string[]> {
  const since = new Date(input.now.getTime() - COMMITTER_WINDOW_DAYS * 86_400_000).toISOString();
  const commits: CommitItem[] = [];
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    const res = await octokit.request("GET /repos/{owner}/{repo}/commits", { owner: input.owner, repo: input.repo, since, per_page: 100, page });
    const items = res.data as CommitItem[];
    commits.push(...items);
    if (items.length < 100) break;
  }
  return committerHashes(input.accountId, commits);
}

/** The account's active committers: everyone who committed to one of its private, enabled repositories. */
export function activeCommitters(repos: { private: boolean; enabled: boolean; committers?: string[] }[]): number {
  return new Set(repos.filter((r) => r.private && r.enabled).flatMap((r) => r.committers ?? [])).size;
}
