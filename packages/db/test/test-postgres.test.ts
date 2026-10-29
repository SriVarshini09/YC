import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDb } from "@shapi/db";
import { startTestPostgres, startTimeoutMs } from "../../../test-utils/postgres";

/** A port something else listens on, as when two test files pick the same free port. */
async function busyPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, server };
}

// The test harness itself (test-utils/postgres.ts): every Postgres-backed test file starts one, in parallel.
describe("test Postgres", () => {
  it("a start on a port another server holds fails fast (no server left waiting) and is retried on a new port", async () => {
    const busy = await busyPort();
    try {
      const started = Date.now();
      await expect(startTestPostgres("shapi_busy", { attempts: 1, port: async () => busy.port })).rejects.toThrow(new RegExp(`did not start \\(1 attempt\\): port ${busy.port}: `));
      expect(Date.now() - started).toBeLessThan(30_000);

      let calls = 0;
      const pg = await startTestPostgres("shapi_retry", { port: async () => (calls++ === 0 ? busy.port : (await busyPort().then(({ port, server }) => (server.close(), port)))) });
      expect(calls).toBe(2);
      const db = createDb({ connectionString: pg.url, appRole: false });
      expect((await sql<{ db: string }>`select current_database() as db`.execute(db)).rows).toEqual([{ db: "shapi_retry" }]);
      await db.destroy();
      await pg.stop();
    } finally {
      busy.server.close();
    }
  }, 90_000);

  it("a start that takes longer than its time limit is killed, with a clear error", async () => {
    await expect(startTestPostgres("shapi_slow", { attempts: 2, timeoutMs: 1 })).rejects.toThrow(/did not start \(2 attempts\): port \d+: timed out after 1 ms \| port \d+: timed out after 1 ms/);
  }, 60_000);

  it("takes its start time limit from SHAPI_TEST_PG_START_TIMEOUT_MS, 30 s by default", () => {
    expect(startTimeoutMs({})).toBe(30_000);
    expect(startTimeoutMs({ SHAPI_TEST_PG_START_TIMEOUT_MS: "45000" })).toBe(45_000);
    for (const bad of ["", "0", "-5", "soon", "1.5"]) expect(startTimeoutMs({ SHAPI_TEST_PG_START_TIMEOUT_MS: bad }), bad).toBe(30_000);
  });

  it("stop() resolves even when the data folder cannot be removed yet, and twice in a row", async () => {
    const pg = await startTestPostgres("shapi_stop");
    const db = createDb({ connectionString: pg.url, appRole: false });
    const dir = (await sql<{ data_directory: string }>`show data_directory`.execute(db)).rows[0]!.data_directory;
    await db.destroy();
    // A process whose working folder is the data folder holds it on Windows (EBUSY), as a server that is still exiting does.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: dir, stdio: "ignore" });
    try {
      await expect(pg.stop()).resolves.toBeUndefined();
      await expect(pg.stop()).resolves.toBeUndefined();
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 90_000);
});
