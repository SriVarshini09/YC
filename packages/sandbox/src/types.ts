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
  /** Destroy the sandbox and everything in it. Safe to call twice. */
  close(): Promise<void>;
}

export interface SandboxOptions {
  /** Hard limit on the sandbox's lifetime; it is destroyed after this even if close() is never called. */
  lifetimeMs?: number;
  network?: NetworkMode;
  /** Non-secret labels for finding the sandbox in the provider's dashboard (for example the job id). */
  labels?: Record<string, string>;
}

export interface SandboxProvider {
  readonly name: "e2b" | "local";
  create(opts?: SandboxOptions): Promise<Sandbox>;
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
