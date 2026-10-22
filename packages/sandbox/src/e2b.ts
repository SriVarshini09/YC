import { CommandExitError, Sandbox as E2BSandbox, TimeoutError } from "e2b";
import { SHAPI_TEMPLATE } from "./template";
import { REGISTRY_HOSTS, safeRelative, truncate, type ExecOptions, type ExecResult, type NetworkMode, type Sandbox, type SandboxOptions, type SandboxProvider, type SnapshotFile } from "./types";

const ROOT = "/home/user/repo";
/** E2B caps one write request; snapshots go up in batches. */
const WRITE_BATCH = 200;

/** POSIX single-quoting: the argument reaches the program exactly as given, with no shell expansion. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function network(mode: NetworkMode) {
  return mode === "off" ? { allowInternetAccess: false } : { denyOut: ({ allTraffic }: { allTraffic: string }) => [allTraffic], allowOut: REGISTRY_HOSTS };
}

export interface E2BProviderOptions {
  apiKey: string;
  /** E2B template (default SHAPI_TEMPLATE, built once per account with `pnpm --filter @shapi/sandbox build-template`). */
  template?: string;
}

/**
 * Sandboxes in E2B Firecracker microVMs: a separate kernel per job, outbound traffic limited to the
 * npm registries (or none), a hard lifetime, and destroyed after use.
 */
export function e2bProvider(opts: E2BProviderOptions): SandboxProvider {
  return {
    name: "e2b",
    async create(o: SandboxOptions = {}): Promise<Sandbox> {
      const vm = await E2BSandbox.create(opts.template ?? SHAPI_TEMPLATE, {
        apiKey: opts.apiKey,
        timeoutMs: o.lifetimeMs ?? 15 * 60_000,
        metadata: o.labels,
        network: (o.network ?? "off") === "off" ? undefined : network("registry"),
        allowInternetAccess: (o.network ?? "off") !== "off",
      });
      let closed = false;
      const run = async (cmd: string, cwd: string, eo: ExecOptions): Promise<ExecResult> => {
        try {
          const r = await vm.commands.run(cmd, { cwd, timeoutMs: eo.timeoutMs ?? 120_000, envs: { CI: "1", FORCE_COLOR: "0", ...eo.env } });
          return { exitCode: r.exitCode, stdout: truncate(r.stdout), stderr: truncate(r.stderr), timedOut: false };
        } catch (err) {
          if (err instanceof CommandExitError) return { exitCode: err.exitCode, stdout: truncate(err.stdout), stderr: truncate(err.stderr), timedOut: false };
          if (err instanceof TimeoutError) return { exitCode: 124, stdout: "", stderr: String(err.message), timedOut: true };
          throw err;
        }
      };
      const exec = (command: string, args: string[], eo: ExecOptions = {}) =>
        run([command, ...args].map(shellQuote).join(" "), eo.cwd ? `${ROOT}/${safeRelative(eo.cwd)}` : ROOT, eo);
      try {
        // The repository folder does not exist yet, so this one runs from the home directory.
        const made = await run(`mkdir -p ${ROOT}`, "/home/user", {});
        if (made.exitCode !== 0) throw new Error(`could not prepare the sandbox: ${made.stderr}`);
      } catch (err) {
        // Never leave a machine running when setup fails.
        await vm.kill().catch(() => {});
        throw err;
      }
      return {
        provider: "e2b",
        id: vm.sandboxId,
        root: ROOT,
        async write(files: SnapshotFile[]) {
          for (let i = 0; i < files.length; i += WRITE_BATCH) {
            const batch = files.slice(i, i + WRITE_BATCH).map((f) => ({
              path: `${ROOT}/${safeRelative(f.path)}`,
              data: typeof f.content === "string" ? f.content : (f.content.buffer.slice(f.content.byteOffset, f.content.byteOffset + f.content.byteLength) as ArrayBuffer),
            }));
            await vm.files.write(batch);
          }
        },
        async read(file: string) {
          try {
            return await vm.files.read(`${ROOT}/${safeRelative(file)}`);
          } catch {
            return undefined;
          }
        },
        exec,
        async setNetwork(mode: NetworkMode) {
          await vm.updateNetwork(network(mode));
        },
        async close() {
          if (closed) return;
          closed = true;
          await vm.kill();
        },
      };
    },
  };
}
