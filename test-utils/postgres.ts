import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export interface TestPostgres {
  /** Connection string for the owner (superuser) role. */
  url: string;
  /** Stop the server and remove its folder. Never throws: a teardown problem must not fail tests that passed. */
  stop(): Promise<void>;
}

export interface TestPostgresOptions {
  /** Starts to try, each on a new port. */
  attempts?: number;
  /** How long one start (initdb, server, database) may take before it is killed and tried again. */
  timeoutMs?: number;
  /** The port for each attempt (tests); a free one by default. */
  port?: () => Promise<number>;
}

/** How long the server may take to exit once killed, before it is killed outright. */
const STOP_TIMEOUT_MS = 10_000;
const READY = "database system is ready to accept connections";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start a throwaway real Postgres (no Docker) in a temp folder, with one fresh database. Test files
 * start these in parallel, and a port found free can be taken before Postgres binds it; a busy machine
 * can also stall a start. So each start has a time limit, a failed or stalled one is killed (no server
 * is left running), and it is retried on a new port.
 */
export async function startTestPostgres(database = "shapi_test", opts: TestPostgresOptions = {}): Promise<TestPostgres> {
  const attempts = opts.attempts ?? 3;
  const errors: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await startOnce(database, await (opts.port ?? freePort)(), opts.timeoutMs ?? 30_000);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`embedded Postgres did not start (${attempts} attempt${attempts === 1 ? "" : "s"}): ${errors.join(" | ")}`);
}

/**
 * Remove a data folder. On Windows the stopped server can hold it for a moment (EBUSY): retry, and if it
 * is still held, leave it in the temp folder rather than fail tests that passed.
 */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // left for the OS temp cleanup
  }
}

/** The server process embedded-postgres started (it keeps it private). */
const serverOf = (pg: EmbeddedPostgres) => pg as unknown as { process?: ChildProcess };

/**
 * Stop the server, if one runs, and wait for it to exit. embedded-postgres's own stop() waits for an
 * exit event, so on a server that already exited (a failed start) it would wait forever, here and in its
 * exit hook: such a server is only forgotten. One that does not exit in time is killed outright.
 */
async function kill(pg: EmbeddedPostgres): Promise<void> {
  const server = serverOf(pg).process;
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    serverOf(pg).process = undefined;
    return;
  }
  const exited = await withTimeout(pg.stop(), STOP_TIMEOUT_MS).then(
    () => true,
    () => false,
  );
  if (!exited) {
    server.kill("SIGKILL");
    serverOf(pg).process = undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startOnce(database: string, port: number, timeoutMs: number): Promise<TestPostgres> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-pg-"));
  let log = "";
  let ready!: () => void;
  const readySeen = new Promise<void>((resolve) => (ready = resolve));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password: "postgres",
    // The folder is removed here, with retries: embedded-postgres removes it in stop() without any, and
    // on Windows that rejects with EBUSY while the killed server still holds it.
    persistent: true,
    // Match production: UTF-8 everywhere (Windows would otherwise default to WIN1252).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    // Only the address the URL names: with "localhost", a port another server holds on 127.0.0.1 still
    // starts on ::1, and the tests would talk to that other server.
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: (message) => {
      // embedded-postgres looks for the ready line in each chunk of output; it can be split across two.
      log = (log + message).slice(-4000);
      if (log.includes(READY)) ready();
    },
    onError: () => {},
  });
  let cancelled = false;
  const boot = (async () => {
    await pg.initialise();
    if (cancelled) return;
    await Promise.race([pg.start(), readySeen]);
    if (cancelled) return;
    const client = pg.getPgClient("postgres", "127.0.0.1");
    await client.connect();
    try {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(database)}`);
    } finally {
      await client.end();
    }
  })();
  try {
    await withTimeout(boot, timeoutMs);
  } catch (err) {
    cancelled = true;
    await kill(pg);
    removeDir(dir);
    // A step still running at the time limit (initdb, or a server spawned just now) stops at the next
    // check; kill whatever it started once it settles.
    void boot
      .catch(() => undefined)
      .then(async () => {
        await kill(pg);
        removeDir(dir);
      });
    const lines = log.trim().split(/\r?\n/).slice(-3).join(" / ");
    const why = err instanceof Error && err.message ? err.message : "the server exited";
    throw new Error(`port ${port}: ${why}${lines ? ` (log: ${lines})` : ""}`, { cause: err });
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/${database}`,
    async stop() {
      await kill(pg);
      removeDir(dir);
    },
  };
}
