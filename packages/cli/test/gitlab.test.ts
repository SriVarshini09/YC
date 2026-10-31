import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run, type FixDeps } from "shapi";
import { deliverToGitLab, gitlabProjectFromUrl } from "../src/gitlab";

// Execution plan U-06: GitLab merge requests with the same fix, test and description as a GitHub PR.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-gitlab-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake GitLab API: one project, its files per branch, and the merge requests opened on it. */
function fakeGitLab(files: Record<string, string>) {
  const branches = new Map<string, Map<string, string>>([["main", new Map(Object.entries(files))]]);
  const mrs: { iid: number; source_branch: string; title: string; description: string; labels?: string }[] = [];
  const calls: string[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    expect((init?.headers as Record<string, string>)["private-token"]).toBe("glpat-test");
    const rest = url.pathname.replace("/api/v4/projects/acme%2Fbilling%2Fapi", "");
    calls.push(`${method} ${rest}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && rest === "") return json(200, { default_branch: "main" });
    let m = /^\/repository\/files\/([^/]+)$/.exec(rest);
    if (m) {
      const content = branches.get(url.searchParams.get("ref")!)?.get(decodeURIComponent(m[1]!));
      return content === undefined ? json(404, { message: "404 File Not Found" }) : json(200, { content: Buffer.from(content).toString("base64"), encoding: "base64" });
    }
    m = /^\/repository\/branches\/([^/]+)$/.exec(rest);
    if (m) return branches.has(decodeURIComponent(m[1]!)) ? json(200, { name: decodeURIComponent(m[1]!) }) : json(404, { message: "404 Branch Not Found" });
    if (method === "POST" && rest === "/repository/branches") {
      branches.set(body.branch, new Map(branches.get("main")));
      return json(201, { name: body.branch });
    }
    if (method === "POST" && rest === "/repository/commits") {
      const files = branches.get(body.branch)!;
      for (const a of body.actions) {
        expect(a.action).toBe(files.has(a.file_path) ? "update" : "create");
        files.set(a.file_path, a.content);
      }
      return json(201, { id: `c${calls.length}` });
    }
    if (method === "GET" && rest === "/merge_requests") return json(200, mrs.filter((r) => r.source_branch === url.searchParams.get("source_branch")).map((r) => ({ iid: r.iid, web_url: `https://gitlab.com/acme/billing/api/-/merge_requests/${r.iid}` })));
    if (method === "POST" && rest === "/merge_requests") {
      mrs.push({ iid: mrs.length + 1, ...body });
      return json(201, { iid: mrs.length, web_url: `https://gitlab.com/acme/billing/api/-/merge_requests/${mrs.length}` });
    }
    m = /^\/merge_requests\/(\d+)$/.exec(rest);
    if (m && method === "PUT") {
      Object.assign(mrs[Number(m[1]) - 1]!, body);
      return json(200, { iid: Number(m[1]), web_url: `https://gitlab.com/acme/billing/api/-/merge_requests/${m[1]}` });
    }
    return json(500, { message: `unexpected ${method} ${rest}` });
  }) as typeof globalThis.fetch;
  return { fetch, branches, mrs, calls };
}

describe("GitLab merge requests (U-06)", () => {
  it("reads GitLab projects from https and ssh clone URLs, with subgroups and self-managed hosts", () => {
    expect(gitlabProjectFromUrl("https://gitlab.com/acme/billing/api.git")).toEqual({ baseUrl: "https://gitlab.com", path: "acme/billing/api" });
    expect(gitlabProjectFromUrl("git@gitlab.com:acme/api.git")).toEqual({ baseUrl: "https://gitlab.com", path: "acme/api" });
    expect(gitlabProjectFromUrl("https://oauth2:secret@gitlab.example.org/team/svc")).toEqual({ baseUrl: "https://gitlab.example.org", path: "team/svc" });
    expect(gitlabProjectFromUrl("https://github.com/acme/api.git")).toBeUndefined();
  });

  it("opens a merge request on a new shapi/ branch, and a rerun updates it instead of opening another", async () => {
    const gl = fakeGitLab({ "src/deploy.ts": "old\n" });
    const project = { baseUrl: "https://gitlab.com", path: "acme/billing/api" };
    const files = [
      { path: "src/deploy.ts", content: "fixed\n", before: "old\n" },
      { path: "test/shapi/x.test.ts", content: "test\n", before: "" },
    ];
    const meta = { title: "SHAPI: x", body: "## body", branch: "shapi/x", commitMessage: "fix: x" };
    const first = await deliverToGitLab(project, files, meta, { token: "glpat-test", fetch: gl.fetch });
    expect(first).toEqual({ url: "https://gitlab.com/acme/billing/api/-/merge_requests/1", number: 1, branch: "shapi/x", commit: expect.any(String) });
    expect(gl.mrs).toEqual([{ iid: 1, source_branch: "shapi/x", target_branch: "main", title: "SHAPI: x", description: "## body", labels: "shapi", remove_source_branch: true }]);
    expect([...gl.branches.get("shapi/x")!]).toEqual([
      ["src/deploy.ts", "fixed\n"],
      ["test/shapi/x.test.ts", "test\n"],
    ]);
    const second = await deliverToGitLab(project, files, { ...meta, body: "## new body" }, { token: "glpat-test", fetch: gl.fetch });
    expect(second.number).toBe(1);
    expect(gl.mrs).toHaveLength(1);
    expect(gl.mrs[0]!.description).toBe("## new body");
  });

  it("refuses a fix whose file changed on the target branch since it was computed", async () => {
    const gl = fakeGitLab({ "src/deploy.ts": "someone else's change\n" });
    await expect(
      deliverToGitLab({ baseUrl: "https://gitlab.com", path: "acme/billing/api" }, [{ path: "src/deploy.ts", content: "fixed\n", before: "old\n" }], { title: "t", body: "b", branch: "shapi/x", commitMessage: "m" }, { token: "glpat-test", fetch: gl.fetch }),
    ).rejects.toThrow("src/deploy.ts changed on main");
    expect(gl.mrs).toEqual([]);
  });

  it("shapi fix --mr hands the same fix, test and description as --pr to the GitLab delivery", async () => {
    const dir = path.join(tmp, "mr");
    cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:acme/billing/api.git"], { cwd: dir });
    const delivered: Parameters<NonNullable<FixDeps["deliverMr"]>>[] = [];
    const deliverMr: FixDeps["deliverMr"] = async (project, files, meta) => {
      delivered.push([project, files, meta]);
      return { url: "https://gitlab.com/acme/billing/api/-/merge_requests/7", number: 7, branch: meta.branch, commit: "c0ffee" };
    };
    let out = "";
    const code = await run(["node", "shapi", "fix", dir, "--advisory", "github-workflow-dispatch-204-to-200", "--mr", "--db", path.join(tmp, "none.db")], { stdout: (s) => (out += s), stderr: (s) => (out += s) }, { deliverMr });
    expect(code).toBe(0);
    expect(out).toContain("merge request: https://gitlab.com/acme/billing/api/-/merge_requests/7");
    const [[project, files, meta]] = delivered as [Parameters<NonNullable<FixDeps["deliverMr"]>>];
    expect(project).toEqual({ baseUrl: "https://gitlab.com", path: "acme/billing/api" });
    expect(meta.branch).toBe("shapi/github-workflow-dispatch-204-to-200");
    expect(meta.title).toBe("SHAPI: workflow_dispatch returns 200 with a body instead of 204");
    expect(meta.body).toContain("deterministic recipe `status-code-accept-set`");
    expect(files.map((f) => f.path)).toEqual(["src/deploy.ts", "test/shapi/github-workflow-dispatch-204-to-200.test.ts"]);
    expect(files[0]!.before).toBe(readFileSync(path.join(dir, "src", "deploy.ts"), "utf8"));
  }, 120_000);

  it("refuses --mr without a GitLab origin, and without GITLAB_TOKEN", async () => {
    const dir = path.join(tmp, "nomr");
    cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
    let out = "";
    const io = { stdout: (s: string) => (out += s), stderr: (s: string) => (out += s) };
    expect(await run(["node", "shapi", "fix", dir, "--mr"], io, {})).not.toBe(0);
    expect(out).toContain("--mr needs a GitLab repository");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/acme/api.git"], { cwd: dir });
    const saved = process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    out = "";
    expect(await run(["node", "shapi", "fix", dir, "--mr"], io, {})).not.toBe(0);
    expect(out).toContain("--mr needs GITLAB_TOKEN");
    if (saved !== undefined) process.env.GITLAB_TOKEN = saved;
  }, 60_000);
});
