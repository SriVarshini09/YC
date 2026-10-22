import { createDb } from "@shapi/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { flushErrors, initErrorReporting, reportError } from "./observability";
import { startSender } from "./queue";

const config = loadConfig();
initErrorReporting(config, "web");
const db = createDb({ connectionString: config.DATABASE_URL });
let sender: Awaited<ReturnType<typeof startSender>> | undefined;
const app = buildApp({
  db,
  config,
  enqueueWebhook: async (deliveryId) => {
    if (!sender) throw new Error("job queue not started");
    await sender.enqueueWebhook(deliveryId);
  },
});
const log = {
  info: (obj: object, msg?: string) => app.log.info(obj, msg),
  error: (obj: object, msg?: string) => {
    if ("err" in obj) reportError(obj.err);
    app.log.error(obj, msg);
  },
};

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await sender?.boss.stop({ graceful: true, timeout: 10_000 });
  await db.destroy();
  await flushErrors();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  sender = await startSender(config.DATABASE_URL, log);
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  reportError(err);
  app.log.error({ err }, "web failed to start");
  await flushErrors();
  process.exit(1);
}
