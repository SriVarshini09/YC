import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ApiLockSchema } from "@shapi/core";
import { run } from "shapi";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "app");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-cli-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function shapi(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(["node", "shapi", ...args], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

describe("shapi scan", () => {
  it("prints providers, affected call sites with file:line, exposed sites and deadlines, and exits 1 on critical", async () => {
    const { code, stdout } = await shapi("scan", fixture, "--now", "2026-10-21");
    expect(code).toBe(1);
    expect(stdout).toContain("1 file · 3 call sites · 3 providers");
    expect(stdout).toMatch(/github\s+2 call sites/);
    expect(stdout).toContain("Affected call sites (2)");
    expect(stdout).toMatch(/CRITICAL\s+src\/jobs\.ts:2\s+POST \/repos\/\{owner\}\/\{repo\}\/actions\/workflows\/\{workflow\}\/dispatches/);
    expect(stdout).toContain("why: compares the response status to 204");
    expect(stdout).toMatch(/HIGH\s+src\/jobs\.ts:15/);
    expect(stdout).toContain("Exposed, not affected (1)");
    expect(stdout).toContain("2026-12-04 (44 days)  hubspot");
    expect(stdout).not.toContain("\u001b["); // no color when not a TTY
  });

  it("--fail-on controls the exit code", async () => {
    expect((await shapi("scan", fixture, "--fail-on", "none")).code).toBe(0);
    expect((await shapi("scan", fixture, "--fail-on", "high")).code).toBe(1);
    const bad = await shapi("scan", fixture, "--fail-on", "sometimes");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--fail-on: expected one of");
  });

  it("--json prints a report whose lock validates against the api.lock schema", async () => {
    const { stdout } = await shapi("scan", fixture, "--json", "--now", "2026-10-21");
    const report = JSON.parse(stdout);
    expect(() => ApiLockSchema.parse(report.lock)).not.toThrow();
    expect(report.affected[0]).toMatchObject({
      advisory: "github-workflow-dispatch-204-to-200",
      severity: "critical",
      file: "src/jobs.ts",
      line: 2,
      reasons: ["compares the response status to 204"],
    });
    expect(report.affected[0].callSite).toBe(report.lock.callSites[0].id);
    expect(report.upcoming).toEqual([
      expect.objectContaining({ advisory: "hubspot-pipelines-v1-sunset", daysUntil: 44, callSites: 0 }),
    ]);
  });

  it("--out writes a deterministic api.lock", async () => {
    const a = path.join(tmp, "a", "api.lock");
    const b = path.join(tmp, "b.lock");
    await shapi("scan", fixture, "--out", a);
    await shapi("scan", fixture, "--out", b);
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
    expect(ApiLockSchema.parse(JSON.parse(readFileSync(a, "utf8"))).callSites).toHaveLength(3);
  });

  it("--repo clones a git repository and scans it", async () => {
    const repo = path.join(tmp, "repo");
    cpSync(fixture, repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    const { code, stdout } = await shapi("scan", "--repo", repo, "--now", "2026-10-21");
    expect(code).toBe(1);
    expect(stdout).toContain(`SHAPI scan  ${repo}`);
    expect(stdout).toMatch(/CRITICAL\s+src\/jobs\.ts:2/);
  });

  it("reports a missing directory as an error", async () => {
    const { code, stderr } = await shapi("scan", path.join(tmp, "does-not-exist"));
    expect(code).toBe(2);
    expect(stderr).toMatch(/^shapi: /);
  });
});
