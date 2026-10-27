import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export interface TestPostgres {
  /** Connection string for the owner (superuser) role. */
  url: string;
  stop(): Promise<void>;
}

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
 * start these in parallel, and a port found free can be taken before Postgres binds it, so a failed
 * start is retried on a new port.
 */
export async function startTestPostgres(database = "shapi_test"): Promise<TestPostgres> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await startOnce(database);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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

async function startOnce(database: string): Promise<TestPostgres> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    // Match production: UTF-8 everywhere (Windows would otherwise default to WIN1252).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(database);
  } catch (err) {
    await pg.stop().catch(() => {});
    removeDir(dir);
    throw err;
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/${database}`,
    async stop() {
      await pg.stop();
      removeDir(dir);
    },
  };
}
