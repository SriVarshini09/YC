import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import { APP_ROLE } from "./migrations";
import type { Database } from "./schema";

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export interface DbOptions {
  connectionString: string;
  /** Run as the restricted app role (default). Migrations pass false to run as the owner. */
  appRole?: boolean;
  max?: number;
}

/** A Kysely client over a pg pool. Every connection switches to the app role, so row-level security applies. */
export function createDb(opts: DbOptions): Db {
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: opts.max ?? 10 });
  if (opts.appRole !== false) {
    pool.on("connect", (client) => {
      void client.query(`set role ${APP_ROLE}`);
    });
  }
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Run `fn` in a transaction scoped to one customer account: row-level security shows and accepts
 * only that account's rows, whatever the queries inside forget to filter.
 */
export async function withTenant<T>(db: Db, accountId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^\d+$/.test(accountId)) throw new Error(`invalid account id ${accountId}`);
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.account_id', ${accountId}, true)`.execute(tx);
    return fn(tx);
  });
}

/** Run `fn` as the service (cross-tenant background work such as webhook handling and advisory fan-out). */
export async function withService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.service', 'on', true)`.execute(tx);
    return fn(tx);
  });
}

/** Cheap liveness check for readiness probes. */
export async function ping(db: Db): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}
