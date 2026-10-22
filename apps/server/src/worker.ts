import { createDb } from "@shapi/db";
import { loadConfig } from "./config";
import { flushErrors, initErrorReporting, reportError } from "./observability";
import { startWorker } from "./queue";

const config = loadConfig();
initErrorReporting(config, "worker");

const log = {
  info: (obj: object, msg?: string) => console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg, ...obj })),
  error: (obj: object, msg?: string) => {
    if ("err" in obj) reportError(obj.err);
    console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), msg, ...obj, err: String((obj as { err?: unknown }).err ?? "") }));
  },
};

const db = createDb({ connectionString: config.DATABASE_URL });
try {
  const boss = await startWorker({ databaseUrl: config.DATABASE_URL, db, config, env: process.env, log });
  log.info({ cron: config.CANARY_CRON, githubApp: Boolean(config.githubApp) }, "worker started");
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await boss.stop({ graceful: true, timeout: 30_000 });
    await db.destroy();
    await flushErrors();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (err) {
  log.error({ err }, "worker failed to start");
  await flushErrors();
  process.exit(1);
}
