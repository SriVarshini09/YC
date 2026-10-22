import { createDb } from "@shapi/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { flushErrors, initErrorReporting, reportError } from "./observability";

const config = loadConfig();
initErrorReporting(config, "web");
const db = createDb({ connectionString: config.DATABASE_URL });
const app = buildApp({ db, config });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.destroy();
  await flushErrors();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  reportError(err);
  app.log.error({ err }, "web failed to start");
  await flushErrors();
  process.exit(1);
}
