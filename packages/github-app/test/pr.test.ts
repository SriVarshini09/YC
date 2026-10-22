import { describe, expect, it } from "vitest";
import { authFromEnv, octokitFor, openFixPr, repoFromUrl } from "@shapi/github-app";

/** A fake GitHub REST API: answers by method + path and records every request body. */
function fakeGitHub(overrides: Record<string, () => Response> = {}) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const routes: Record<string, () => Response> = {
    "GET /repos/acme/demo": () => json(200, { default_branch: "main" }),
    "GET /repos/acme/demo/git/ref/heads/main": () => json(200, { object: { sha: "base-sha" } }),
    "GET /repos/acme/demo/git/commits/base-sha": () => json(200, { tree: { sha: "base-tree" } }),
    "GET /repos/acme/demo/git/trees/base-tree": () => json(200, { tree: [{ path: "src/deploy.ts" }, { path: "src" }] }),
    "GET /repos/acme/demo/contents/src/deploy.ts": () =>
      json(200, { type: "file", encoding: "base64", content: Buffer.from("old\nfile\n").toString("base64") }),
    "POST /repos/acme/demo/git/trees": () => json(201, { sha: "new-tree" }),
    "POST /repos/acme/demo/git/commits": () => json(201, { sha: "new-commit" }),
    "POST /repos/acme/demo/git/refs": () => json(201, { ref: "refs/heads/shapi/x" }),
    "POST /repos/acme/demo/pulls": () => json(201, { number: 7, html_url: "https://github.com/acme/demo/pull/7" }),
    ...overrides,
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // Octokit encodes the ref's slash (heads%2Fmain); GitHub accepts both forms
    const pathname = decodeURIComponent(new URL(String(input)).pathname);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("authorization") });
    const route = routes[`${method} ${pathname}`];
    if (!route) return json(404, { message: `no route ${method} ${pathname}` });
    return route();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const pr = {
  repo: "acme/demo",
  branch: "shapi/github-workflow-dispatch-204-to-200",
  title: "SHAPI: workflow_dispatch returns 200",
  body: "body",
  commitMessage: "fix: accept 200",
  files: [
    { path: "src/deploy.ts", content: "fixed" },
    { path: "test/shapi/x.test.ts", content: "test" },
  ],
};

describe("openFixPr", () => {
  it("commits the files on a new branch off the default branch and opens a PR", async () => {
    const gh = fakeGitHub();
    const opened = await openFixPr(octokitFor({ token: "t0k" }, { fetch: gh.fetch }), pr);
    expect(opened).toEqual({ url: "https://github.com/acme/demo/pull/7", number: 7, branch: pr.branch, commit: "new-commit" });
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/acme/demo",
      "GET /repos/acme/demo/git/ref/heads/main",
      "GET /repos/acme/demo/git/commits/base-sha",
      "GET /repos/acme/demo/git/trees/base-tree",
      "GET /repos/acme/demo/contents/src/deploy.ts",
      "POST /repos/acme/demo/git/trees",
      "POST /repos/acme/demo/git/commits",
      "POST /repos/acme/demo/git/refs",
      "POST /repos/acme/demo/pulls",
    ]);
    expect(gh.calls[5]!.body).toEqual({
      base_tree: "base-tree",
      tree: [
        { path: "src/deploy.ts", mode: "100644", type: "blob", content: "fixed" },
        { path: "test/shapi/x.test.ts", mode: "100644", type: "blob", content: "test" },
      ],
    });
    expect(gh.calls[6]!.body).toEqual({ message: "fix: accept 200", tree: "new-tree", parents: ["base-sha"] });
    expect(gh.calls[7]!.body).toEqual({ ref: `refs/heads/${pr.branch}`, sha: "new-commit" });
    expect(gh.calls[8]!.body).toEqual({ head: pr.branch, base: "main", title: pr.title, body: "body" });
    expect(gh.calls[0]!.auth).toBe("token t0k");
  });

  it("keeps each file's line endings from the base branch", async () => {
    const crlfBase = fakeGitHub({
      "GET /repos/acme/demo/contents/src/deploy.ts": () =>
        new Response(JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from("a\r\nb\r\n").toString("base64") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const files = [
      { path: "src/deploy.ts", content: "x\ny\n" },
      { path: "test/shapi/x.test.ts", content: "t\r\nu\r\n" },
    ];
    await openFixPr(octokitFor({ token: "t" }, { fetch: crlfBase.fetch }), { ...pr, files });
    const tree = crlfBase.calls.find((c) => c.path.endsWith("/git/trees"))!.body as { tree: { path: string; content: string }[] };
    // the existing CRLF file stays CRLF; a new file is written with LF
    expect(tree.tree.map((t) => t.content)).toEqual(["x\r\ny\r\n", "t\nu\n"]);

    const lfBase = fakeGitHub();
    await openFixPr(octokitFor({ token: "t" }, { fetch: lfBase.fetch }), { ...pr, files: [{ path: "src/deploy.ts", content: "x\r\ny\r\n" }] });
    const lfTree = lfBase.calls.find((c) => c.path.endsWith("/git/trees"))!.body as { tree: { content: string }[] };
    expect(lfTree.tree[0]!.content).toBe("x\ny\n");
  });

  it("explains an existing branch instead of failing with a raw 422", async () => {
    const gh = fakeGitHub({
      "POST /repos/acme/demo/git/refs": () => new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422, headers: { "content-type": "application/json" } }),
    });
    await expect(openFixPr(octokitFor({ token: "t" }, { fetch: gh.fetch }), pr)).rejects.toThrow(/already exists on acme\/demo/);
  });
});

describe("helpers", () => {
  it("parses GitHub repository URLs", () => {
    expect(repoFromUrl("https://github.com/SriVarshini09/shapi-demo")).toBe("SriVarshini09/shapi-demo");
    expect(repoFromUrl("https://github.com/SriVarshini09/shapi-demo.git\n")).toBe("SriVarshini09/shapi-demo");
    expect(repoFromUrl("git@github.com:acme/demo.git")).toBe("acme/demo");
    expect(repoFromUrl("https://gitlab.com/acme/demo")).toBeUndefined();
  });

  it("prefers GitHub App credentials, then a token", () => {
    expect(authFromEnv({ SHAPI_GITHUB_APP_ID: "1", SHAPI_GITHUB_APP_INSTALLATION_ID: "2", SHAPI_GITHUB_APP_PRIVATE_KEY: "k", GITHUB_TOKEN: "t" })).toEqual({
      appId: "1",
      installationId: 2,
      privateKey: "k",
    });
    expect(authFromEnv({ GH_TOKEN: "t" })).toEqual({ token: "t" });
  });
});
