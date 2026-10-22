import { createDb, migrateToLatest } from "@shapi/db";
import { loadConfig } from "./config";
import { prepareQueues } from "./queue";

// Runs before each deploy (Fly release_command). Connects as the owner, not the app role.
const config = loadConfig();
const db = createDb({ connectionString: config.DATABASE_URL, appRole: false, max: 1 });
try {
  const applied = await migrateToLatest(db);
  console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));
  // The job queue's own schema and queues, so the web process can queue jobs before any worker starts.
  await prepareQueues(config.DATABASE_URL);
  console.log(JSON.stringify({ level: "info", msg: "queues ready" }));
} catch (err) {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", err: String(err) }));
  process.exitCode = 1;
} finally {
  await db.destroy();
}
