import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeRelative, truncate, type ExecOptions, type ExecResult, type Sandbox, type SandboxOptions, type SandboxProvider, type SnapshotFile } from "./types";

/**
 * A temp folder on this machine. NOT isolated: code runs with this machine's network, files and
 * user. For local development and tests with your own code only; the hosted service refuses it.
 */
export function localProvider(): SandboxProvider {
  return {
    name: "local",
    async create(o: SandboxOptions = {}): Promise<Sandbox> {
      const root = mkdtempSync(path.join(os.tmpdir(), "shapi-sandbox-"));
      const lifetime = setTimeout(() => rmSync(root, { recursive: true, force: true }), o.lifetimeMs ?? 15 * 60_000);
      lifetime.unref();
      let closed = false;
      return {
        provider: "local",
        id: path.basename(root),
        root,
        async write(files: SnapshotFile[]) {
          for (const f of files) {
            const abs = path.join(root, safeRelative(f.path));
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, f.content);
          }
        },
        async read(file: string) {
          try {
            return readFileSync(path.join(root, safeRelative(file)), "utf8");
          } catch {
            return undefined;
          }
        },
        exec(command: string, args: string[], eo: ExecOptions = {}): Promise<ExecResult> {
          return new Promise((resolve) => {
            const child = spawn(command, args, {
              cwd: eo.cwd ? path.join(root, safeRelative(eo.cwd)) : root,
              // A minimal environment: nothing of the caller's tokens or credentials.
              env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: root, USERPROFILE: root, CI: "1", FORCE_COLOR: "0", ...eo.env },
              shell: process.platform === "win32" && /^(npm|npx|pnpm|yarn|corepack)$/.test(command),
            });
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            child.stdout.on("data", (d) => (stdout += d));
            child.stderr.on("data", (d) => (stderr += d));
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, eo.timeoutMs ?? 120_000);
            const done = (exitCode: number, extra = "") => {
              clearTimeout(timer);
              resolve({ exitCode: timedOut ? 124 : exitCode, stdout: truncate(stdout), stderr: truncate(stderr + extra), timedOut });
            };
            child.on("error", (err) => done(127, String(err)));
            child.on("close", (code) => done(code ?? 1));
          });
        },
        async setNetwork() {
          // A local folder has the machine's network; nothing to change.
        },
        async close() {
          if (closed) return;
          closed = true;
          clearTimeout(lifetime);
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    },
  };
}
