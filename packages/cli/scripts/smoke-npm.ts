// Installs the built `shapi-cli` tarball into an empty folder, as a user would, and runs it:
//   node packages/cli/scripts/build-npm.ts && node packages/cli/scripts/smoke-npm.ts
// Fails unless `scan` finds the demo's GitHub breakage (exit 1: affected call sites) and `fix`
// repairs it test-first (exit 0).
import { execSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(cliDir, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-smoke-"));
const env = { ...process.env, FORCE_COLOR: "0" };
const check = (what: string, ok: boolean, detail: string) => {
  if (!ok) throw new Error(`${what} failed:\n${detail}`);
  console.log(`ok  ${what}`);
};

try {
  execSync(`npm pack --pack-destination "${tmp}"`, { cwd: path.join(cliDir, "npm"), stdio: "pipe" });
  const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"))!;
  cpSync(path.join(root, "fixtures/demo-ts"), path.join(tmp, "demo"), { recursive: true });
  rmSync(path.join(tmp, "demo", "api.lock"), { force: true });
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  execSync(`npm install --no-audit --no-fund "${path.join(tmp, tarball)}"`, { cwd: tmp, stdio: "pipe", env });

  const bin = path.join(tmp, "node_modules", "shapi-cli", "bin", "shapi.js");
  const shapi = (...args: string[]) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: "utf8", env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  const version = shapi("--version");
  check("shapi --version", version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out), version.out);
  const scan = shapi("scan", "demo");
  check("scan finds the GitHub dispatch breakage (exit 1)", scan.code === 1 && scan.out.includes("github-workflow-dispatch-204-to-200"), scan.out);
  const json = shapi("scan", "demo", "--json");
  const report = JSON.parse(json.out) as { lock?: { callSites?: unknown[] } };
  check("scan --json includes the api.lock", (report.lock?.callSites?.length ?? 0) > 0, json.out.slice(0, 500));
  const fix = shapi("fix", "demo", "--advisory", "github-workflow-dispatch-204-to-200");
  check("fix repairs it test-first with the recipe (exit 0)", fix.code === 0 && /FIXED.*via recipe/.test(fix.out), fix.out);
  console.log(`shapi-cli smoke test passed (${tarball})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
