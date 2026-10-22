import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run, type FixDeps } from "shapi";

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
    const delivered: { repo: string; files: { path: string; content: string }[]; meta: { title: string; body: string; branch: string } }[] = [];
    const deliver: FixDeps["deliver"] = async (repo, files, meta) => {
      delivered.push({ repo, files, meta });
      return { url: "https://github.com/acme/demo/pull/1", number: 1, branch: meta.branch, commit: "c0ffee" };
    };
    // --pr needs a GitHub remote; point origin at a fake one
    const { execFileSync } = await import("node:child_process");
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
    const body = d!.meta.body;
    expect(body).toContain("`src/deploy.ts:13`");
    expect(body).toContain("deterministic recipe `status-code-accept-set`");
    expect(body).toMatch(/\| Before this change \| fail \(1 failed \| 1 passed\) \|/);
    expect(body).toMatch(/\| After this change \| pass \(2 passed\) \|/);
    expect(body).toContain("| Provider notice | none (undocumented change) |");
    expect(body).toContain("| Shapes from | recording github-workflow-dispatch-204-to-200.json |");
    expect(body).toContain("| Blast radius | 1 affected call site in this repo |");
  }, 120_000);

  it("refuses --pr without a GitHub repository", async () => {
    const { code, out } = await shapi(["fix", demo("no-remote"), "--pr"]);
    expect(code).toBe(2);
    expect(out).toContain("--pr needs a GitHub repository");
  });
});
