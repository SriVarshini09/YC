// Triggers a GitHub Actions deploy workflow, the way Terrateam did before
// GitHub's workflow_dispatch endpoint started answering 200 instead of 204.
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";

export interface DeployRequest {
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
}

export async function triggerDeploy(req: DeployRequest, token: string): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${req.owner}/${req.repo}/actions/workflows/${req.workflow}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: req.ref }),
  });
  if (res.status !== 204) {
    throw new Error(`deploy dispatch failed with ${res.status}`);
  }
}

export async function latestDeployConclusion(req: DeployRequest, token: string): Promise<string | undefined> {
  const res = await fetch(`${GITHUB_API}/repos/${req.owner}/${req.repo}/actions/workflows/${req.workflow}/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { workflow_runs: { id: number; conclusion: string | null }[] };
  const run = body.workflow_runs[0];
  if (run?.conclusion === "success" || run?.conclusion === "failure") return run.conclusion;
  return undefined;
}
