// Run SHAPI locally against the real GitHub App, before any deploy:
//   pnpm build && pnpm --filter @shapi/server dev
// Starts Postgres (embedded, data kept in .shapi/dev-postgres), applies migrations, runs the web
// process on :8080 and the worker in this process, and forwards the app's smee.io webhooks to it.
// Credentials come from .shapi/github-app.env, written by `pnpm --filter @shapi/server github:register`.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import SmeeClient from "smee-client";
import { createDb, migrateToLatest } from "@shapi/db";
import { buildApp, loadConfig, prepareQueues, startSender, startWorker } from "../dist/index.js";

const shapiDir = fileURLToPath(new URL("../../../.shapi", import.meta.url));
const envFile = path.join(shapiDir, "github-app.env");
if (!existsSync(envFile)) throw new Error(`${envFile} not found: run pnpm --filter @shapi/server github:register first`);
process.loadEnvFile(envFile);
// Fixes are verified in E2B when a key is saved locally; otherwise in a local folder (your own code only).
const e2bEnv = path.join(shapiDir, "e2b.env");
if (existsSync(e2bEnv)) process.loadEnvFile(e2bEnv);
// Stripe test-mode billing, when a test key, price and webhook secret are saved locally.
const stripeEnv = path.join(shapiDir, "stripe.env");
if (existsSync(stripeEnv)) process.loadEnvFile(stripeEnv);

const dataDir = path.join(shapiDir, "dev-postgres");
const port = Number(process.env.SHAPI_DEV_PG_PORT ?? 54329);
const fresh = !existsSync(dataDir);
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user: "postgres",
  password: "postgres",
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("shapi");

const url = `postgres://postgres:postgres@127.0.0.1:${port}/shapi`;
process.env.DATABASE_URL = url;
process.env.CANARY_CRON ??= "";
const config = loadConfig(process.env);

const ownerDb = createDb({ connectionString: url, appRole: false, max: 1 });
console.log("migrations applied:", await migrateToLatest(ownerDb));
await ownerDb.destroy();
await prepareQueues(url);

const log = {
  info: (obj: object, msg?: string) => console.log(msg ?? "", JSON.stringify(obj)),
  error: (obj: object, msg?: string) => console.error(msg ?? "", String((obj as { err?: unknown }).err ?? JSON.stringify(obj))),
};
const db = createDb({ connectionString: url });
const sender = await startSender(url, log);
const app = buildApp({ db, config: { ...config, LOG_LEVEL: "warn" }, enqueueWebhook: sender.enqueueWebhook });
// "localhost" binds both 127.0.0.1 and ::1, so a browser on either reaches this server.
await app.listen({ port: config.PORT, host: "localhost" });
const boss = await startWorker({ databaseUrl: url, db, config, env: process.env, log });
console.log(`web on ${config.webApp?.publicUrl ?? `http://localhost:${config.PORT}`}, worker running, GitHub App ${config.githubApp ? config.githubApp.appId : "not configured"}`);

const source = process.env.SHAPI_GITHUB_WEBHOOK_URL;
let smee: SmeeClient | undefined;
if (source?.startsWith("https://smee.io/")) {
  smee = new SmeeClient({ source, target: `http://127.0.0.1:${config.PORT}/github/webhook`, logger: { info: () => {}, error: console.error } });
  await smee.start();
  console.log(`forwarding ${source} to /github/webhook`);
}

const shutdown = async () => {
  await smee?.stop();
  await app.close();
  await boss.stop({ graceful: false, timeout: 5_000 });
  await sender.boss.stop({ graceful: false });
  await db.destroy();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
