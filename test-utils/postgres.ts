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

/** Start a throwaway real Postgres (no Docker) in a temp folder, with one fresh database. */
export async function startTestPostgres(database = "shapi_test"): Promise<TestPostgres> {
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
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(database);
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/${database}`,
    async stop() {
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
