/**
 * Fix delivery to GitLab (execution plan U-06): the same fix, contract test and description as a GitHub pull
 * request, as a GitLab merge request, through the REST API (v4). One branch per advisory (`shapi/<id>`), so a
 * rerun updates the merge request instead of opening another.
 */

export interface GitLabProject {
  /** `https://gitlab.com` or a self-managed host. */
  baseUrl: string;
  /** `group/subgroup/project`. */
  path: string;
}

export interface OpenedMergeRequest {
  url: string;
  number: number;
  branch: string;
  commit: string;
}

export interface MergeRequestFile {
  path: string;
  content: string;
  /** What the fix was computed from ("" for a new file). */
  before: string;
}

/** A GitLab project from a clone URL: https://gitlab.com/a/b(.git), git@gitlab.com:a/b.git, or another host whose name has "gitlab". */
export function gitlabProjectFromUrl(url: string): GitLabProject | undefined {
  const u = url.trim();
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(u);
  if (ssh && /gitlab/i.test(ssh[1]!)) return { baseUrl: `https://${ssh[1]}`, path: ssh[2]! };
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(u);
  if (http && /gitlab/i.test(http[1]!) && http[2]!.includes("/")) return { baseUrl: `https://${http[1]}`, path: http[2]! };
  return undefined;
}

type Fetch = typeof globalThis.fetch;

/** Open (or update) the merge request for one fix. `token` is a GitLab personal, project or group access token with `api` scope. */
export async function deliverToGitLab(
  project: GitLabProject,
  files: MergeRequestFile[],
  meta: { title: string; body: string; branch: string; commitMessage: string; baseSha?: string },
  opts: { token: string; fetch?: Fetch },
): Promise<OpenedMergeRequest> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const id = encodeURIComponent(project.path);
  const api = async <T>(method: string, apiPath: string, body?: unknown, allow404 = false): Promise<T | undefined> => {
    const res = await doFetch(`${project.baseUrl}/api/v4/projects/${id}${apiPath}`, {
      method,
      headers: { "private-token": opts.token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allow404 && res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitLab ${method} ${apiPath.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  const file = (path: string, ref: string) => api<{ content: string; encoding: string }>("GET", `/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, undefined, true);
  const decode = (f: { content: string; encoding: string } | undefined) => (f ? (f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content) : undefined);

  const info = (await api<{ default_branch: string }>("GET", ""))!;
  const target = info.default_branch;
  // A file changed on the target since the fix was computed: refused, as on GitHub, so the merge request never undoes someone's work.
  for (const f of files) {
    const current = decode(await file(f.path, target)) ?? "";
    if (current.replace(/\r\n/g, "\n") !== f.before.replace(/\r\n/g, "\n")) throw new Error(`not delivered: ${f.path} changed on ${target} since the fix was computed; run shapi fix again`);
  }

  const existing = await api<{ name: string }>("GET", `/repository/branches/${encodeURIComponent(meta.branch)}`, undefined, true);
  if (!existing) await api("POST", "/repository/branches", { branch: meta.branch, ref: meta.baseSha ?? target });
  const actions = [];
  for (const f of files) actions.push({ action: (await file(f.path, meta.branch)) ? "update" : "create", file_path: f.path, content: f.content });
  const commit = (await api<{ id: string }>("POST", "/repository/commits", { branch: meta.branch, commit_message: meta.commitMessage, actions }))!;

  const open = (await api<{ iid: number; web_url: string }[]>("GET", `/merge_requests?state=opened&source_branch=${encodeURIComponent(meta.branch)}`)) ?? [];
  const mr = open[0]
    ? (await api<{ iid: number; web_url: string }>("PUT", `/merge_requests/${open[0].iid}`, { title: meta.title, description: meta.body }))!
    : (await api<{ iid: number; web_url: string }>("POST", "/merge_requests", { source_branch: meta.branch, target_branch: target, title: meta.title, description: meta.body, labels: "shapi", remove_source_branch: true }))!;
  return { url: mr.web_url, number: mr.iid, branch: meta.branch, commit: commit.id };
}
