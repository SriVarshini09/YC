import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ResponseShapeSchema, shapeHash, type ResponseShape } from "./shape";

export interface Observation {
  provider: string;
  method: string;
  /** Endpoint pattern as in provider docs, for example /repos/{owner}/{repo}. */
  endpoint: string;
  /** ISO timestamp. */
  observedAt: string;
  /** Where the observation came from, for example "canary:github" or "replay". */
  source: string;
  shape: ResponseShape;
}

export interface StoredObservation extends Observation {
  id: number;
  shapeHash: string;
}

export interface EndpointSummary {
  provider: string;
  method: string;
  endpoint: string;
  source: string;
  observations: number;
  distinctShapes: number;
  lastObservedAt: string;
}

interface Row {
  id: number;
  provider: string;
  method: string;
  endpoint: string;
  observed_at: string;
  source: string;
  shape_hash: string;
  shape_json: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Anything that stores observed shapes: the local SQLite `ShapeStore` (synchronous) or the hosted
 * Postgres store in `@shapi/db` (asynchronous). Callers `await` every method so either works.
 */
export interface ShapeRepository {
  record(obs: Observation): MaybePromise<StoredObservation>;
  history(provider: string, method: string, endpoint: string, opts?: { limit?: number; source?: string }): MaybePromise<StoredObservation[]>;
  latest(provider: string, method: string, endpoint: string, source?: string): MaybePromise<StoredObservation | undefined>;
  previousDistinct(provider: string, method: string, endpoint: string, source?: string): MaybePromise<StoredObservation | undefined>;
  endpoints(): MaybePromise<EndpointSummary[]>;
}

const SCHEMA_VERSION = 1;

/** SQLite store of observed response shapes (better-sqlite3), for the CLI and local runs. */
export class ShapeStore implements ShapeRepository {
  private constructor(private readonly db: Database.Database) {}

  /** Open (and create or migrate) a store. Use ":memory:" for tests. */
  static open(file: string): ShapeStore {
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    if (file !== ":memory:") db.pragma("journal_mode = WAL");
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version < SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          source TEXT NOT NULL,
          shape_hash TEXT NOT NULL,
          shape_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS observations_endpoint
          ON observations (provider, method, endpoint, observed_at);
      `);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    return new ShapeStore(db);
  }

  record(obs: Observation): StoredObservation {
    const shape = ResponseShapeSchema.parse(obs.shape);
    const hash = shapeHash(shape);
    const info = this.db
      .prepare(
        `INSERT INTO observations (provider, method, endpoint, observed_at, source, shape_hash, shape_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(obs.provider, obs.method, obs.endpoint, obs.observedAt, obs.source, hash, JSON.stringify(shape));
    return { ...obs, shape, id: Number(info.lastInsertRowid), shapeHash: hash };
  }

  /**
   * Observations of one endpoint, newest first. Pass `source` to stay within one
   * vantage point: the same endpoint answers differently with and without a token,
   * so observations from different sources must not be compared.
   */
  history(
    provider: string,
    method: string,
    endpoint: string,
    opts: { limit?: number; source?: string } = {},
  ): StoredObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observations WHERE provider = ? AND method = ? AND endpoint = ? AND (? IS NULL OR source = ?)
         ORDER BY observed_at DESC, id DESC LIMIT ?`,
      )
      .all(provider, method, endpoint, opts.source ?? null, opts.source ?? null, opts.limit ?? 100) as Row[];
    return rows.map(fromRow);
  }

  latest(provider: string, method: string, endpoint: string, source?: string): StoredObservation | undefined {
    return this.history(provider, method, endpoint, { limit: 1, source })[0];
  }

  /** The most recent observation whose shape differs from the latest one: the "before" side of the last change. */
  previousDistinct(provider: string, method: string, endpoint: string, source?: string): StoredObservation | undefined {
    const latest = this.latest(provider, method, endpoint, source);
    if (!latest) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM observations WHERE provider = ? AND method = ? AND endpoint = ? AND (? IS NULL OR source = ?)
           AND shape_hash != ?
         ORDER BY observed_at DESC, id DESC LIMIT 1`,
      )
      .get(provider, method, endpoint, source ?? null, source ?? null, latest.shapeHash) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** One row per endpoint and source. */
  endpoints(): EndpointSummary[] {
    return this.db
      .prepare(
        `SELECT provider, method, endpoint, source, COUNT(*) AS observations, COUNT(DISTINCT shape_hash) AS distinctShapes,
                MAX(observed_at) AS lastObservedAt
         FROM observations GROUP BY provider, method, endpoint, source ORDER BY provider, endpoint, method, source`,
      )
      .all() as EndpointSummary[];
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: Row): StoredObservation {
  return {
    id: row.id,
    provider: row.provider,
    method: row.method,
    endpoint: row.endpoint,
    observedAt: row.observed_at,
    source: row.source,
    shapeHash: row.shape_hash,
    shape: ResponseShapeSchema.parse(JSON.parse(row.shape_json)),
  };
}
