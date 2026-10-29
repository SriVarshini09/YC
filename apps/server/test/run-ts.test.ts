import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// scripts/run-ts.mjs runs the server's dev and preview scripts (and the CLI's build scripts).
const RUN_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "run-ts.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-run-ts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, code: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, code);
  return file;
}

// Node strips types by default here; --no-experimental-strip-types makes it behave like Node 22.14 to 22.17.
const modes = [
  { name: "in this process (types stripped by default)", flags: [] as string[] },
  { name: "in a child (Node without default type stripping)", flags: ["--no-experimental-strip-types"] },
];

describe.each(modes)("run-ts.mjs, $name", ({ flags }) => {
  it("passes the arguments on, and exits with the script's exit code", () => {
    const file = script("exit.ts", "const args: string[] = process.argv.slice(2);\nconsole.log(JSON.stringify({ args, file: process.argv[1] }));\nprocess.exitCode = 7;\n");
    const run = spawnSync(process.execPath, [...flags, RUN_TS, file, "a", "--b"], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(7);
    expect(JSON.parse(run.stdout)).toEqual({ args: ["a", "--b"], file });
  });

  it.skipIf(process.platform === "win32")("dies of the signal that killed the script", () => {
    const file = script("signal.ts", 'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 10_000);\n');
    const run = spawnSync(process.execPath, [...flags, RUN_TS, file], { encoding: "utf8", timeout: 15_000 });
    expect(run.signal).toBe("SIGTERM");
  });

  it.skipIf(process.platform === "win32")("lets the script handle a SIGTERM sent to it, and exits as the script does", async () => {
    const file = script("stop.ts", 'process.on("SIGTERM", () => { console.log("stopped cleanly"); process.exit(0); });\nconsole.log("ready");\nsetTimeout(() => {}, 10_000);\n');
    const child = spawn(process.execPath, [...flags, RUN_TS, file], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += String(d);
      if (out.includes("ready")) child.kill("SIGTERM");
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    expect(out).toContain("stopped cleanly");
    expect(code).toBe(0);
  }, 20_000);
});

it("runs the script in its own process when Node strips types by default: no wrapper process is left to outlive a stop", () => {
  const file = script("pid.ts", "console.log(process.pid);\n");
  const run = spawnSync(process.execPath, [RUN_TS, file], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(Number(run.stdout.trim())).toBe(run.pid);
});
