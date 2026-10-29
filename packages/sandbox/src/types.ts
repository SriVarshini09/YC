/** One file of a repository snapshot, by repo-relative POSIX path. */
export interface SnapshotFile {
  path: string;
  content: string | Buffer;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command ran past its timeout and was stopped. */
  timedOut: boolean;
}

export interface ExecOptions {
  /** Working directory relative to the sandbox root (default: the root). */
  cwd?: string;
  timeoutMs?: number;
  /** Extra non-secret environment variables (never tokens or keys). */
  env?: Record<string, string>;
}

/**
 * Network for the sandbox. "registry": only the npm registries, for installing dependencies.
 * "off": nothing at all, for running a repository's code and tests.
 */
export type NetworkMode = "registry" | "off";

/**
 * A disposable machine holding one copy of a repository. Untrusted code (install scripts, tests)
 * only ever runs here. Nothing secret goes in: no tokens, no SHAPI credentials, no environment.
 */
export interface Sandbox {
  readonly provider: "e2b" | "local";
  readonly id: string;
  /** Absolute path of the repository inside the sandbox. */
  readonly root: string;
  write(files: SnapshotFile[]): Promise<void>;
  read(file: string): Promise<string | undefined>;
  /** Run a program with arguments (no shell expansion of the arguments). */
  exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  setNetwork(mode: NetworkMode): Promise<void>;
  /**
   * Keep the sandbox alive for at least `ms` more. Throws instead when that would take it past its
   * maximum lifetime, so a job that outgrows one sandbox stops with a clear error rather than
   * failing on a machine that was destroyed mid-command.
   */
  extend(ms: number): Promise<void>;
  /** Destroy the sandbox and everything in it. Safe to call twice. */
  close(): Promise<void>;
}

export interface SandboxOptions {
  /** Initial lifetime (default 15 minutes); the sandbox is destroyed after it even if close() is never called. extend() moves it. */
  lifetimeMs?: number;
  /** How far extend() may move the lifetime, from creation (default MAX_SANDBOX_LIFETIME_MS). */
  maxLifetimeMs?: number;
  network?: NetworkMode;
  /** Non-secret labels for finding the sandbox in the provider's dashboard (for example the job id). */
  labels?: Record<string, string>;
}

export interface SandboxProvider {
  readonly name: "e2b" | "local";
  create(opts?: SandboxOptions): Promise<Sandbox>;
}

/** The lifetime a sandbox starts with. */
export const DEFAULT_SANDBOX_LIFETIME_MS = 15 * 60_000;
/** The most extend() allows, from creation: an hour, which is also E2B's limit on its Hobby plan. */
export const MAX_SANDBOX_LIFETIME_MS = 60 * 60_000;

/** Tracks a sandbox's deadline for extend(): `set(ms)` applies a new remaining lifetime. */
export function lifetime(o: SandboxOptions, set: (ms: number) => Promise<void> | void): (ms: number) => Promise<void> {
  const created = Date.now();
  const max = o.maxLifetimeMs ?? MAX_SANDBOX_LIFETIME_MS;
  let deadline = created + (o.lifetimeMs ?? DEFAULT_SANDBOX_LIFETIME_MS);
  return async (ms) => {
    const now = Date.now();
    const want = now + ms;
    if (want <= deadline) return;
    if (want > created + max) {
      throw new Error(`the sandbox reached its ${Math.round(max / 60_000)}-minute lifetime limit: the job needs more time than one sandbox allows`);
    }
    await set(want - now);
    deadline = want;
  };
}

/** Hosts reachable in "registry" mode: npm, Yarn, and the package-manager downloads Corepack makes. */
export const REGISTRY_HOSTS = ["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"];

/** Output kept per stream, so a noisy test run cannot blow up a job's memory or logs. */
export const OUTPUT_LIMIT = 64 * 1024;

export function truncate(s: string): string {
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT / 2)}\n... (${s.length - OUTPUT_LIMIT} characters cut) ...\n${s.slice(-OUTPUT_LIMIT / 2)}` : s;
}

/** A repo-relative path that cannot escape the repository. */
export function safeRelative(file: string): string {
  const parts = file.replaceAll("\\", "/").split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..") || /^[a-zA-Z]:$/.test(parts[0]!) || file.startsWith("/")) {
    throw new Error(`refusing path outside the repository: ${file}`);
  }
  return parts.join("/");
}
