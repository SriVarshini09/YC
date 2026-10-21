import { Octokit } from "@octokit/rest";

const API = "https://api.github.com";

export async function dispatch(owner: string, repo: string, workflow: string, token: string) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) {
    throw new Error(`dispatch failed: ${res.status}`);
  }
}

export async function latestRun(owner: string, repo: string) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/actions/runs?per_page=1&status=completed`);
  if (!res.ok) return undefined;
  const remaining = res.headers.get("X-RateLimit-Remaining");
  const body = (await res.json()) as { workflow_runs: { id: number; conclusion: string; head_sha: string }[] };
  const run = body.workflow_runs[0];
  if (body.workflow_runs[0].conclusion === "success") return { run, remaining };
  switch (body.workflow_runs[0].conclusion) {
    case "failure":
    case "cancelled":
      return undefined;
  }
  return run;
}

const octokit = new Octokit();
export async function viaSdk() {
  const { status, data } = await octokit.rest.pulls.get({ owner: "o", repo: "r", pull_number: 1 });
  if ([200, 304].includes(status)) {
    return data.merged ? data.merge_commit_sha : data.state === "open";
  }
}
