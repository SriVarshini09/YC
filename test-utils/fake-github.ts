import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { create } from "tar";

/**
 * An in-memory GitHub for one repository, enough for SHAPI's scan and PR jobs: git refs, commits and
 * trees, file contents and tarballs, branches, check runs, pull requests, labels, issues, and the
 * installation's repository list. Tests drive it like a maintainer would (close a PR, push to a
 * branch, tick a box) and read its state back.
 */
export interface FakePull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: { name: string }[];
  /** null while GitHub computes it; false when the PR conflicts with its base. */
  mergeable: boolean | null;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
}

export interface FakeCheckRun {
  id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion?: string;
  output?: { title: string; summary: string; annotations: { path: string; start_line: number; annotation_level: string }[] };
}

/** GitHub's tarball layout: every file under one "<owner>-<repo>-<sha>/" folder. */
async function tarball(owner: string, repo: string, sha: string, files: Map<string, string>): Promise<Buffer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-tarball-"));
  const top = `${owner}-${repo}-${sha.slice(0, 7)}`;
  try {
    for (const [file, content] of files) {
      mkdirSync(path.dirname(path.join(dir, top, file)), { recursive: true });
      writeFileSync(path.join(dir, top, file), content);
    }
    const chunks: Buffer[] = [];
    for await (const c of create({ gzip: true, cwd: dir, portable: true }, [top])) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function fakeRepoGitHub(fullName: string, files: Record<string, string>, opts: { defaultBranch?: string; repoId?: number } = {}) {
  const [owner, repo] = fullName.split("/") as [string, string];
  const defaultBranch = opts.defaultBranch ?? "main";
  let seq = 0;
  const id = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(8, "0")}`;
  const trees = new Map<string, Map<string, string>>();
  /** File modes per tree; a file not listed is "100644". */
  const modes = new Map<string, Map<string, string>>();
  const commits = new Map<string, { message: string; tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  const pulls: FakePull[] = [];
  const checkRuns: FakeCheckRun[] = [];
  const issues: FakeIssue[] = [];
  let nextNumber = 1;
  const calls: { method: string; path: string; body: unknown }[] = [];

  const rootTree = id("tree");
  trees.set(rootTree, new Map(Object.entries(files)));
  const rootCommit = id("commit");
  commits.set(rootCommit, { message: "initial", tree: rootTree, parents: [] });
  refs.set(defaultBranch, rootCommit);

  const json = (status: number, body: unknown, url = "") => {
    const res = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const notFound = () => json(404, { message: "Not Found" });
  const treeAt = (ref: string) => {
    const sha = refs.get(ref) ?? ref;
    const commit = commits.get(sha);
    return commit ? trees.get(commit.tree) : undefined;
  };

  /** Test helpers: what a maintainer would do. */
  const github = {
    owner,
    repo,
    repoId: opts.repoId ?? 1,
    defaultBranch,
    pulls,
    checkRuns,
    issues,
    calls,
    refs,
    commits,
    fileAt: (ref: string, path: string) => treeAt(ref)?.get(path),
    /** Give a file in the tree at `ref` another mode, for example "100755". */
    setMode(ref: string, path: string, mode: string) {
      const tree = commits.get(refs.get(ref) ?? ref)!.tree;
      modes.set(tree, new Map([...(modes.get(tree) ?? []), [path, mode]]));
    },
    /** Someone else pushes a commit on top of a branch. */
    pushAs(branch: string, path: string, content: string, message = "manual edit") {
      const parent = refs.get(branch)!;
      const tree = new Map(trees.get(commits.get(parent)!.tree)!);
      tree.set(path, content);
      const treeSha = id("tree");
      trees.set(treeSha, tree);
      modes.set(treeSha, new Map(modes.get(commits.get(parent)!.tree)));
      const sha = id("commit");
      commits.set(sha, { message, tree: treeSha, parents: [parent] });
      refs.set(branch, sha);
      return sha;
    },
    close(number: number, merged = false) {
      const pr = pulls.find((p) => p.number === number)!;
      pr.state = "closed";
      pr.merged_at = merged ? new Date().toISOString() : null;
      if (merged) refs.set(pr.base.ref, refs.get(pr.head.ref)!);
    },
    label(number: number, name: string) {
      pulls.find((p) => p.number === number)!.labels.push({ name });
    },
    /** Tick the dashboard checkbox whose hidden marker contains `marker`. */
    tick(issueNumber: number, marker: string) {
      const issue = issues.find((i) => i.number === issueNumber)!;
      issue.body = issue.body.split("\n").map((l) => (l.includes(`<!-- shapi:${marker} -->`) ? l.replace("- [ ]", "- [x]") : l)).join("\n");
    },
  };

  const prefix = `/repos/${owner}/${repo}`;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const href = url.href;

    if (/^POST \/app\/installations\/\d+\/access_tokens$/.test(`${method} ${path}`)) {
      return json(201, { token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "all" });
    }
    if (method === "GET" && path === "/installation/repositories") {
      const repositories = [{ id: opts.repoId ?? 1, full_name: fullName, default_branch: defaultBranch, private: true }];
      return json(200, { total_count: 1, repositories }, href);
    }
    if (!path.startsWith(prefix)) return notFound();
    const rest = path.slice(prefix.length);
    let m: RegExpExecArray | null;

    if (method === "GET" && rest === "") return json(200, { default_branch: defaultBranch, full_name: fullName });
    if (method === "GET" && (m = /^\/branches\/(.+)$/.exec(rest))) {
      const sha = refs.get(m[1]!);
      return sha ? json(200, { name: m[1], commit: { sha } }) : notFound();
    }
    if (method === "GET" && (m = /^\/tarball\/(.+)$/.exec(rest))) {
      const sha = refs.get(m[1]!) ?? m[1]!;
      const tree = treeAt(sha);
      if (!tree) return notFound();
      const res = new Response(await tarball(owner, repo, sha, tree), { status: 200, headers: { "content-type": "application/x-gzip" } });
      Object.defineProperty(res, "url", { value: href });
      return res;
    }
    if (method === "POST" && rest === "/check-runs") {
      const run: FakeCheckRun = { id: 9000 + checkRuns.length + 1, head_sha: body.head_sha, name: body.name, status: body.status };
      checkRuns.push(run);
      return json(201, run);
    }
    if (method === "PATCH" && (m = /^\/check-runs\/(\d+)$/.exec(rest))) {
      const run = checkRuns.find((r) => r.id === Number(m![1]));
      if (!run) return notFound();
      const annotations = [...(run.output?.annotations ?? []), ...(body.output?.annotations ?? [])];
      Object.assign(run, body.status ? { status: body.status } : {}, body.conclusion ? { conclusion: body.conclusion } : {}, { output: { ...body.output, annotations } });
      return json(200, run);
    }
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = refs.get(m[1]!);
      return sha ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha } }) : notFound();
    }
    if (method === "GET" && (m = /^\/git\/matching-refs\/heads\/(.+)$/.exec(rest))) {
      const prefix = m[1]!;
      return json(200, [...refs].filter(([name]) => name.startsWith(prefix)).map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } })), href);
    }
    if (method === "GET" && (m = /^\/git\/commits\/(.+)$/.exec(rest))) {
      const c = commits.get(m[1]!);
      return c ? json(200, { sha: m[1], message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : notFound();
    }
    // Subdirectories are trees "<root tree>:<dir>" and files are blobs "<root tree>:<path>", listed one level at a time.
    if (method === "GET" && (m = /^\/git\/trees\/(.+)$/.exec(rest))) {
      const [rootSha, dir = ""] = m[1]!.split(/:(.*)/s) as [string, string?];
      const t = trees.get(rootSha);
      if (!t) return notFound();
      const mode = (p: string) => modes.get(rootSha)?.get(p) ?? "100644";
      if (url.searchParams.has("recursive")) return json(200, { sha: m[1], tree: [...t.keys()].map((p) => ({ path: p, mode: mode(p), type: "blob", sha: `${rootSha}:${p}` })), truncated: false });
      const prefix = dir ? `${dir}/` : "";
      const entries = new Map<string, { path: string; mode: string; type: string; sha: string }>();
      for (const p of t.keys()) {
        if (!p.startsWith(prefix)) continue;
        const [name, ...more] = p.slice(prefix.length).split("/") as [string, ...string[]];
        const full = `${prefix}${name}`;
        entries.set(name, more.length ? { path: name, mode: "040000", type: "tree", sha: `${rootSha}:${full}` } : { path: name, mode: mode(full), type: "blob", sha: `${rootSha}:${full}` });
      }
      return dir && entries.size === 0 ? notFound() : json(200, { sha: m[1], tree: [...entries.values()], truncated: false });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/(.+)$/.exec(rest))) {
      const [rootSha, file] = m[1]!.split(/:(.*)/s) as [string, string?];
      const content = file === undefined ? undefined : trees.get(rootSha)?.get(file);
      return content === undefined ? notFound() : json(200, { sha: m[1], encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });
    }
    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const content = treeAt(url.searchParams.get("ref") ?? defaultBranch)?.get(m[1]!);
      if (content === undefined) return notFound();
      // Like GitHub, files over 1 MB come back without their content.
      if (Buffer.byteLength(content) > 1024 * 1024) return json(200, { type: "file", encoding: "none", content: "" });
      return json(200, { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    if (method === "POST" && rest === "/git/trees") {
      const tree = new Map(trees.get(body.base_tree) ?? []);
      const treeModes = new Map(modes.get(body.base_tree));
      for (const e of body.tree as { path: string; content: string; mode: string }[]) {
        tree.set(e.path, e.content);
        treeModes.set(e.path, e.mode);
      }
      const sha = id("tree");
      trees.set(sha, tree);
      modes.set(sha, treeModes);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/commits") {
      const sha = id("commit");
      commits.set(sha, { message: body.message, tree: body.tree, parents: body.parents });
      return json(201, { sha });
    }
    if (method === "POST" && rest === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (refs.has(name)) return json(422, { message: "Reference already exists" });
      refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      if (!refs.has(m[1]!)) return json(422, { message: "Reference does not exist" });
      refs.set(m[1]!, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      const list = pulls
        .filter((p) => !head || `${owner}:${p.head.ref}` === head)
        .filter((p) => state === "all" || p.state === state)
        .sort((a, b) => b.number - a.number)
        .map((p) => ({ ...p, head: { ...p.head, sha: refs.get(p.head.ref) ?? p.head.sha } }));
      return json(200, list, href);
    }
    if (method === "POST" && rest === "/pulls") {
      const number = nextNumber++;
      const pr: FakePull = {
        number,
        html_url: `https://github.com/${fullName}/pull/${number}`,
        state: "open",
        merged_at: null,
        title: body.title,
        body: body.body,
        head: { ref: body.head, sha: refs.get(body.head)! },
        base: { ref: body.base },
        labels: [],
        mergeable: null,
      };
      pulls.push(pr);
      return json(201, pr);
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = pulls.find((p) => p.number === Number(m![1]));
      if (!pr) return notFound();
      if (method === "GET") return json(200, pr);
      Object.assign(pr, body.title !== undefined ? { title: body.title } : {}, body.body !== undefined ? { body: body.body } : {});
      return json(200, pr);
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/labels$/.exec(rest))) {
      const pr = pulls.find((p) => p.number === Number(m![1]));
      if (!pr) return notFound();
      for (const name of body.labels as string[]) if (!pr.labels.some((l) => l.name === name)) pr.labels.push({ name });
      return json(200, pr.labels);
    }
    if (method === "POST" && rest === "/issues") {
      const issue: FakeIssue = { number: nextNumber++, title: body.title, body: body.body, state: "open" };
      issues.push(issue);
      return json(201, issue);
    }
    if ((m = /^\/issues\/(\d+)$/.exec(rest))) {
      const issue = issues.find((i) => i.number === Number(m![1]));
      if (!issue) return notFound();
      if (method === "PATCH") Object.assign(issue, body);
      return json(200, issue);
    }
    return json(404, { message: `fake GitHub has no route ${method} ${path}` });
  }) as typeof globalThis.fetch;

  return { fetch, github };
}
