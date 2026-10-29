import { execFileSync } from "node:child_process";

/** GITHUB_TOKEN, or the GitHub CLI's token when it is signed in; undefined runs unauthenticated (60 requests an hour). */
export function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function gh<T>(apiPath: string, token: string | undefined): Promise<T> {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "shapi-bench", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GET ${apiPath}: ${res.status}`);
  return (await res.json()) as T;
}
