import type { Probe, Worker } from "../probe";

const API = "https://api.github.com";

/**
 * GitHub canary. Public endpoints run without credentials (60 requests/hour
 * unauthenticated). The workflow_dispatch probe needs a SHAPI-owned test repo:
 * SHAPI_GITHUB_TOKEN, SHAPI_CANARY_REPO ("owner/name") and SHAPI_CANARY_WORKFLOW
 * (file name or id), optionally SHAPI_CANARY_REF (default "main").
 */
export const githubWorker: Worker = {
  provider: "github",
  probes(env) {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shapi-canary",
    };
    if (env.SHAPI_GITHUB_TOKEN) headers.Authorization = `Bearer ${env.SHAPI_GITHUB_TOKEN}`;
    const auth = env.SHAPI_GITHUB_TOKEN ? "token" : "anonymous";
    const get = (id: string, endpoint: string, path: string): Probe => ({
      id: `github:${id}`,
      provider: "github",
      method: "GET",
      endpoint,
      url: `${API}${path}`,
      headers,
      auth,
    });

    const probes: Probe[] = [
      get("rate-limit", "/rate_limit", "/rate_limit"),
      get("get-repo", "/repos/{owner}/{repo}", "/repos/octocat/Hello-World"),
      get("list-workflows", "/repos/{owner}/{repo}/actions/workflows", "/repos/actions/checkout/actions/workflows"),
      get("list-runs", "/repos/{owner}/{repo}/actions/runs", "/repos/actions/checkout/actions/runs?per_page=1"),
    ];
    const skipped: { id: string; reason: string }[] = [];

    const repo = env.SHAPI_CANARY_REPO;
    const workflow = env.SHAPI_CANARY_WORKFLOW;
    if (env.SHAPI_GITHUB_TOKEN && repo && workflow) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/.test(repo))throw new Error(`SHAPI_CANARY_REPO must be owner/name, got ${repo}`);
      probes.push({
        id: "github:workflow-dispatch",
        provider: "github",
        method: "POST",
        endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        url: `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: env.SHAPI_CANARY_REF ?? "main" }),
        auth: "token",
      });
    } else {
      skipped.push({
        id: "github:workflow-dispatch",
        reason: "needs SHAPI_GITHUB_TOKEN, SHAPI_CANARY_REPO and SHAPI_CANARY_WORKFLOW (a SHAPI-owned test repo)",
      });
    }
    return { probes, skipped };
  },
};
