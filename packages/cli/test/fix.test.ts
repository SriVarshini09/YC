import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ShapeStore, inferShape } from "@shapi/shapes";
import { fix, run, type FixDeps } from "shapi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-fix-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function demo(name: string) {
  const dir = path.join(tmp, name);
  cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
  return dir;
}

async function shapi(args: string[], deps: Partial<FixDeps> = {}) {
  let out = "";
  const code = await run(["node", "shapi", ...args], { stdout: (s) => (out += s), stderr: (s) => (out += s) }, deps);
  return { code, out };
}

describe("shapi fix", () => {
  it("repairs the demo fixture test-first and reports the files it would change", async () => {
    const dir = demo("report");
    const { code, out } = await shapi(["fix", dir, "--advisory", "github-workflow-dispatch-204-to-200", "--db", path.join(tmp, "none.db")]);
    expect(code).toBe(0);
    expect(out).toMatch(/FIXED\s+src\/deploy\.ts:13\s+github-workflow-dispatch-204-to-200\s+via recipe/);
    expect(out).toContain("recipe: passed (status-code-accept-set)");
    expect(out).toContain("M src/deploy.ts");
    expect(out).toContain("A test/shapi/github-workflow-dispatch-204-to-200.test.ts");
    // without --write the repo is untouched
    expect(readFileSync(path.join(dir, "src", "deploy.ts"), "utf8")).toContain("res.status !== 204");
  }, 120_000);

  it("--write applies the fix and the contract test, after which a scan finds nothing to fix", async () => {
    const dir = demo("write");
    await shapi(["fix", dir, "--advisory", "github-workflow-dispatch-204-to-200", "--write", "--db", path.join(tmp, "none.db")]);
    expect(readFileSync(path.join(dir, "src", "deploy.ts"), "utf8")).toContain("![200, 204].includes(res.status)");
    expect(existsSync(path.join(dir, "test", "shapi", "github-workflow-dispatch-204-to-200.test.ts"))).toBe(true);
    const again = await shapi(["fix", dir, "--advisory", "github-workflow-dispatch-204-to-200", "--db", path.join(tmp, "none.db")]);
    expect(again.out).toContain("No affected call sites");
  }, 120_000);

  it("--pr hands the fix, the test and an evidence-rich body to the delivery step", async () => {
    const dir = demo("pr");
    const delivered: { repo: string; files: { path: string; content: string; before: string }[]; meta: { title: string; body: string; branch: string; baseSha?: string } }[] = [];
    const deliver: FixDeps["deliver"] = async (repo, files, meta) => {
      delivered.push({ repo, files, meta });
      return { url: "https://github.com/acme/demo/pull/1", number: 1, branch: meta.branch, commit: "c0ffee" };
    };
    // --pr needs a GitHub remote; point origin at a fake one
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/demo.git"], { cwd: dir });

    const { code, out } = await shapi(["fix", dir, "--advisory", "github-workflow-dispatch-204-to-200", "--pr", "--db", path.join(tmp, "none.db")], { deliver });
    expect(code).toBe(0);
    expect(out).toContain("pull request: https://github.com/acme/demo/pull/1");
    const [d] = delivered;
    expect(d!.repo).toBe("acme/demo");
    expect(d!.meta.branch).toBe("shapi/github-workflow-dispatch-204-to-200");
    expect(d!.meta.title).toBe("SHAPI: workflow_dispatch returns 200 with a body instead of 204");
    expect(d!.files.map((f) => f.path)).toEqual(["src/deploy.ts", "test/shapi/github-workflow-dispatch-204-to-200.test.ts"]);
    // What each file held locally, so delivery can refuse a file that differs on GitHub instead of reverting it.
    expect(d!.files[0]!.before).toBe(readFileSync(path.join(dir, "src", "deploy.ts"), "utf8"));
    expect(d!.files[1]!.before).toBe("");
    // A local checkout is not a GitHub commit: the PR goes on the base's head.
    expect(d!.meta.baseSha).toBeUndefined();
    const body = d!.meta.body;
    expect(body).toContain("` src/deploy.ts:13 `");
    expect(body).toContain("deterministic recipe `status-code-accept-set`");
    expect(body).toContain("### Affected call sites (1 of 1 fixed here)");
    expect(body).toContain("- [x] ` src/deploy.ts:13 ` (` POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches `): fixed, test `test/shapi/github-workflow-dispatch-204-to-200.test.ts`");
    expect(body).toContain("| `test/shapi/github-workflow-dispatch-204-to-200.test.ts` | fail (1 failed \\| 1 passed) | pass (2 passed) |");
    expect(body).toContain("| Provider notice | none (undocumented change) |");
    expect(body).toContain("| Shapes from | recording github-workflow-dispatch-204-to-200.json |");
    expect(body).toContain("| Blast radius | 1 affected call site in this repo |");
  }, 120_000);

  it("deletes its temporary copy of the repository (with its .env) once the repair is done, also on a dry run", async () => {
    const dir = demo("cleanup");
    const outcomes = await fix(dir, { advisory: "github-workflow-dispatch-204-to-200", db: path.join(tmp, "none.db") }, { log: () => {} });
    const copy = outcomes[0]?.result?.sandbox;
    expect(outcomes[0]?.result?.status).toBe("fixed");
    expect(copy).toContain("shapi-repair-");
    expect(existsSync(copy!)).toBe(false);
  }, 120_000);

  it("refuses --pr without a GitHub repository", async () => {
    const { code, out } = await shapi(["fix", demo("no-remote"), "--pr"]);
    expect(code).toBe(2);
    expect(out).toContain("--pr needs a GitHub repository");
  });

  it("refuses an unknown advisory, --write with --repo, and a non-GitHub --repo with --pr, before cloning anything", async () => {
    const typo = await shapi(["fix", demo("typo"), "--advisory", "nope-typo"]);
    expect(typo.code).toBe(2);
    expect(typo.out).toContain("unknown advisory nope-typo");

    const temp = path.join(tmp, "tmpdir");
    mkdirSync(temp);
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
    try {
      const write = await shapi(["fix", "--repo", "https://github.com/acme/demo", "--write"]);
      expect(write.code).toBe(2);
      expect(write.out).toContain("--write writes into a local repository");
      const gitlab = await shapi(["fix", "--repo", "https://gitlab.com/acme/demo", "--pr"]);
      expect(gitlab.code).toBe(2);
      expect(gitlab.out).toContain("--pr needs a GitHub repository");
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("--repo --pr builds the PR on the cloned commit", async () => {
    const dir = demo("clone-src");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "demo");
    const head = git("rev-parse", "HEAD").trim();
    let baseSha: string | undefined;
    const deliver: FixDeps["deliver"] = async (_repo, _files, meta) => {
      baseSha = meta.baseSha;
      return { url: "https://github.com/acme/demo/pull/1", number: 1, branch: meta.branch, commit: "c0ffee" };
    };
    // A local path stands in for the GitHub URL; repoFromUrl only needs github.com/<owner>/<name> in it.
    const linked = path.join(tmp, "github.com", "acme", "demo");
    mkdirSync(path.dirname(linked), { recursive: true });
    cpSync(dir, linked, { recursive: true });
    const { code } = await shapi(["fix", "--repo", linked.split(path.sep).join("/"), "--advisory", "github-workflow-dispatch-204-to-200", "--pr", "--db", path.join(tmp, "none.db")], { deliver });
    expect(code).toBe(0);
    expect(baseSha).toBe(head);
  }, 120_000);

  it("uses the canary store only when it saw the advisory's kind of change, else the bundled recording", async () => {
    const db = path.join(tmp, "header-only.db");
    const store = ShapeStore.open(db);
    const endpoint = "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
    for (const [day, headers] of [["2026-01-01", { "x-a": "1" }], ["2026-01-02", { "x-b": "1" }]] as const) {
      const shape = inferShape({ status: 200, headers: new Headers({ "content-type": "application/json", ...headers }), body: "{}" }, { salt: "s" });
      store.record({ provider: "github", method: "POST", endpoint, observedAt: `${day}T00:00:00Z`, source: "canary:github:token", shape });
    }
    store.close();
    // Two 200s differing in a header say nothing about 204 → 200: the contract test must come from the recording.
    const [outcome] = await fix(demo("store"), { advisory: "github-workflow-dispatch-204-to-200", db }, { log: () => {} });
    expect(outcome).toMatchObject({ shapeSource: "recording github-workflow-dispatch-204-to-200.json", result: { status: "fixed" } });
    expect(outcome!.result!.test!.content).toContain("204");
  }, 120_000);
});
