import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSecrets } from "./secrets";
import { DEFAULT_SANDBOX_LIFETIME_MS, lifetime, safeRelative, truncate, type ExecOptions, type ExecResult, type Sandbox, type SandboxOptions, type SandboxProvider, type SnapshotFile } from "./types";

/**
 * A temp folder on this machine. NOT isolated: code runs with this machine's network, files and
 * user. For local development and tests with your own code only; the hosted service refuses it.
 */
export function localProvider(): SandboxProvider {
  return {
    name: "local",
    async create(o: SandboxOptions = {}): Promise<Sandbox> {
      const root = mkdtempSync(path.join(os.tmpdir(), "shapi-sandbox-"));
      const destroy = (ms: number) => {
        const timer = setTimeout(() => rmSync(root, { recursive: true, force: true }), ms);
        timer.unref();
        return timer;
      };
      let timer = destroy(o.lifetimeMs ?? DEFAULT_SANDBOX_LIFETIME_MS);
      const extend = lifetime(o, (ms) => {
        clearTimeout(timer);
        timer = destroy(ms);
      });
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
          try {
            assertNoSecrets(eo.env);
          } catch (err) {
            return Promise.reject(err);
          }
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
        extend,
        async close() {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        },
      };
    },
  };
}
