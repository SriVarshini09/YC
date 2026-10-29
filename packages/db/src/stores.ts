import { AdvisorySchema, type Advisory } from "@shapi/core";
import {
  ResponseShapeSchema,
  shapeHash,
  type EndpointSummary,
  type Observation,
  type ShapeRepository,
  type StoredObservation,
} from "@shapi/shapes";
import { sql } from "kysely";
import type { Db } from "./client";

/** The canary shape store on Postgres: same behaviour as the local SQLite ShapeStore. */
export class PgShapeStore implements ShapeRepository {
  constructor(private readonly db: Db) {}

  async record(obs: Observation): Promise<StoredObservation> {
    const shape = ResponseShapeSchema.parse(obs.shape);
    const hash = shapeHash(shape);
    const row = await this.db
      .insertInto("observations")
      .values({
        provider: obs.provider,
        method: obs.method,
        endpoint: obs.endpoint,
        observed_at: obs.observedAt,
        source: obs.source,
        shape_hash: hash,
        shape: JSON.stringify(shape),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { ...obs, shape, id: Number(row.id), shapeHash: hash };
  }

  async history(provider: string, method: string, endpoint: string, opts: { limit?: number; source?: string } = {}): Promise<StoredObservation[]> {
    let q = this.db
      .selectFrom("observations")
      .selectAll()
      .where("provider", "=", provider)
      .where("method", "=", method)
      .where("endpoint", "=", endpoint);
    if (opts.source) q = q.where("source", "=", opts.source);
    const rows = await q.orderBy("observed_at", "desc").orderBy("id", "desc").limit(opts.limit ?? 100).execute();
    return rows.map(fromRow);
  }

  /**
   * Delete observations from before `before` that only repeat a shape: a row goes when a newer row of the same
   * endpoint and source has the same shape hash. The newest observation of every distinct shape is kept for good,
   * so shape diffs, previousDistinct and the before/after shapes behind contract tests still work.
   */
  async prune(before: Date): Promise<number> {
    const result = await sql`
      delete from observations o
      where o.observed_at < ${before}
        and exists (
          select 1 from observations n
          where n.provider = o.provider and n.method = o.method and n.endpoint = o.endpoint and n.source = o.source
            and n.shape_hash = o.shape_hash
            and (n.observed_at > o.observed_at or (n.observed_at = o.observed_at and n.id > o.id))
        )`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  async latest(provider: string, method: string, endpoint: string, source?: string): Promise<StoredObservation | undefined> {
    return (await this.history(provider, method, endpoint, { limit: 1, source }))[0];
  }

  async previousDistinct(provider: string, method: string, endpoint: string, source?: string): Promise<StoredObservation | undefined> {
    const latest = await this.latest(provider, method, endpoint, source);
    if (!latest) return undefined;
    let q = this.db
      .selectFrom("observations")
      .selectAll()
      .where("provider", "=", provider)
      .where("method", "=", method)
      .where("endpoint", "=", endpoint)
      .where("shape_hash", "!=", latest.shapeHash);
    if (source) q = q.where("source", "=", source);
    const row = await q.orderBy("observed_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  async endpoints(): Promise<EndpointSummary[]> {
    const rows = await this.db
      .selectFrom("observations")
      .select([
        "provider",
        "method",
        "endpoint",
        "source",
        sql<string>`count(*)`.as("observations"),
        sql<string>`count(distinct shape_hash)`.as("distinct_shapes"),
        sql<Date>`max(observed_at)`.as("last_observed_at"),
      ])
      .groupBy(["provider", "method", "endpoint", "source"])
      .orderBy("provider")
      .orderBy("endpoint")
      .orderBy("method")
      .orderBy("source")
      .execute();
    return rows.map((r) => ({
      provider: r.provider,
      method: r.method,
      endpoint: r.endpoint,
      source: r.source,
      observations: Number(r.observations),
      distinctShapes: Number(r.distinct_shapes),
      lastObservedAt: new Date(r.last_observed_at).toISOString(),
    }));
  }
}

function fromRow(row: {
  id: string;
  provider: string;
  method: string;
  endpoint: string;
  observed_at: Date;
  source: string;
  shape_hash: string;
  shape: unknown;
}): StoredObservation {
  return {
    id: Number(row.id),
    provider: row.provider,
    method: row.method,
    endpoint: row.endpoint,
    observedAt: new Date(row.observed_at).toISOString(),
    source: row.source,
    shapeHash: row.shape_hash,
    shape: ResponseShapeSchema.parse(row.shape),
  };
}

/**
 * Insert or update advisories. Reviewed advisories (from the advisories/ folder) replace whatever is
 * stored; a machine draft never overwrites a reviewed advisory with the same id.
 */
export async function upsertAdvisories(db: Db, advisories: Advisory[], opts: { reviewed: boolean; source: string }): Promise<number> {
  let written = 0;
  for (const advisory of advisories) {
    const data = AdvisorySchema.parse(advisory);
    const res = await db
      .insertInto("advisories")
      .values({ id: data.id, provider: data.provider, data: JSON.stringify(data), reviewed: opts.reviewed, source: opts.source, modified: new Date() })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          provider: (eb) => eb.ref("excluded.provider"),
          data: (eb) => eb.ref("excluded.data"),
          reviewed: (eb) => eb.ref("excluded.reviewed"),
          source: (eb) => eb.ref("excluded.source"),
          modified: (eb) => eb.ref("excluded.modified"),
        })
          // Only a real change counts: re-syncing the same advisory must not bump `modified`, or every
          // worker start would look like new advisories and re-run fix jobs for every repository.
          .where(sql<boolean>`(advisories.data, advisories.reviewed, advisories.source) is distinct from (excluded.data, excluded.reviewed, excluded.source)`)
          .where(opts.reviewed ? sql<boolean>`true` : sql<boolean>`advisories.reviewed = false`),
      )
      .executeTakeFirst();
    written += Number(res.numInsertedOrUpdatedRows ?? 0);
  }
  return written;
}

/** Delete the advisories that came from `source` and are not in `keep`; returns how many were removed. */
export async function removeAdvisoriesNotIn(db: Db, source: string, keep: string[]): Promise<string[]> {
  if (!keep.length) throw new Error("refusing to remove every advisory from a source");
  const rows = await db.deleteFrom("advisories").where("source", "=", source).where("id", "not in", keep).returning("id").execute();
  return rows.map((r) => r.id).sort();
}

/** Advisories as the matcher expects them; reviewed only unless drafts are asked for. */
export async function listAdvisories(db: Db, opts: { includeDrafts?: boolean } = {}): Promise<Advisory[]> {
  let q = db.selectFrom("advisories").select("data").orderBy("id");
  if (!opts.includeDrafts) q = q.where("reviewed", "=", true);
  const rows = await q.execute();
  return rows.map((r) => AdvisorySchema.parse(r.data));
}
