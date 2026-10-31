import { createHash, randomBytes } from "node:crypto";
import { PgShapeStore, withService, withTenant, type Db } from "@shapi/db";
import { SENSOR_ENDPOINTS, WIRE_VERSION, type SensorShape } from "@shapi/sensor";
import { diffShapes, pathHash, providerSalt, shapeHash, type ResponseShape, type StoredObservation } from "@shapi/shapes";
import { sql } from "kysely";
import { z } from "zod";

/**
 * The traffic sensor's server side (execution plan F-01). Customers who opt in run @shapi/sensor (Node) or
 * shapi_sensor (Python), which upload value-free shapes of the responses they get from endpoints SHAPI's advisories
 * name. Each account's shapes are stored as observations of their own source (`sensor:<account id>`), next to the
 * canary's. A change counts only when at least MIN_ACCOUNTS accounts saw it, and it is confirmed when the canary saw
 * the same change on the same endpoint.
 */

/** A change seen by fewer accounts than this is noise or one customer's setup, not the provider. */
export const MIN_ACCOUNTS = 3;
/** The most observations one upload may carry. */
const MAX_OBSERVATIONS = 500;

const JsonType = z.enum(["array", "boolean", "integer", "null", "number", "object", "string"]);
const ShapeSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string().max(64), z.string().max(256)),
  body: z.object({
    kind: z.enum(["empty", "json", "text"]),
    rootType: JsonType.optional(),
    fields: z.array(z.object({ path: z.string().min(1).max(512), types: z.array(JsonType).min(1) })).max(500),
  }),
});
export const SensorBatchSchema = z.object({
  v: z.literal(WIRE_VERSION),
  sdk: z.enum(["node", "python"]),
  observations: z
    .array(
      z.object({
        provider: z.string(),
        method: z.string(),
        endpoint: z.string(),
        shape: ShapeSchema,
        count: z.number().int().min(1),
        firstSeen: z.iso.datetime(),
        lastSeen: z.iso.datetime(),
      }),
    )
    .max(MAX_OBSERVATIONS),
});

export const sensorSource = (accountId: string) => `sensor:${accountId}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new token for the account, replacing any old one. Only its hash is stored; the token is shown once. */
export async function createSensorToken(db: Db, accountId: string): Promise<string> {
  const token = `shapi_sensor_${randomBytes(24).toString("base64url")}`;
  await withTenant(db, accountId, async (tx) => {
    await tx.deleteFrom("sensor_tokens").where("account_id", "=", accountId).execute();
    await tx.insertInto("sensor_tokens").values({ account_id: accountId, token_hash: hashToken(token) }).execute();
  });
  return token;
}

export async function revokeSensorToken(db: Db, accountId: string): Promise<void> {
  await withTenant(db, accountId, (tx) => tx.deleteFrom("sensor_tokens").where("account_id", "=", accountId).execute());
}

export async function sensorTokenInfo(db: Db, accountId: string): Promise<{ createdAt: Date; lastUsedAt: Date | null } | undefined> {
  const row = await withTenant(db, accountId, (tx) => tx.selectFrom("sensor_tokens").select(["created_at", "last_used_at"]).where("account_id", "=", accountId).executeTakeFirst());
  return row ? { createdAt: row.created_at, lastUsedAt: row.last_used_at } : undefined;
}

/** The account a sensor token belongs to, or undefined. */
export async function sensorAccount(db: Db, token: string): Promise<string | undefined> {
  return withService(db, async (tx) => {
    const row = await tx.updateTable("sensor_tokens").set({ last_used_at: new Date() }).where("token_hash", "=", hashToken(token)).returning("account_id").executeTakeFirst();
    return row?.account_id;
  });
}

/** A sensor shape as a stored shape: paths hashed with the provider's salt, like the canary's. */
export function toResponseShape(provider: string, shape: SensorShape, secret: string): ResponseShape {
  const salt = providerSalt(provider, secret);
  return {
    status: shape.status,
    headers: shape.headers,
    headerNames: [],
    body: {
      kind: shape.body.kind,
      ...(shape.body.rootType ? { rootType: shape.body.rootType } : {}),
      fields: shape.body.fields.map((f) => ({
        path: f.path,
        pathHash: pathHash(salt, f.path),
        types: [...f.types].sort(),
        classes: [],
        occurrences: 1,
        nullRate: f.types.length === 1 && f.types[0] === "null" ? 1 : 0,
      })),
    },
  };
}

/**
 * Store one upload. Observations of endpoints the sensor doesn't watch are dropped, so an upload can't put
 * anything else on record; an observation whose shape is the account's latest for that endpoint is not stored again.
 */
export async function ingestSensorBatch(db: Db, accountId: string, batch: z.infer<typeof SensorBatchSchema>, secret: string): Promise<{ stored: number; dropped: number }> {
  const store = new PgShapeStore(db);
  const known = new Set(SENSOR_ENDPOINTS.map((e) => `${e.provider} ${e.method} ${e.path}`));
  const source = sensorSource(accountId);
  let stored = 0;
  let dropped = 0;
  for (const o of batch.observations) {
    if (!known.has(`${o.provider} ${o.method} ${o.endpoint}`) && !known.has(`${o.provider} * ${o.endpoint}`)) {
      dropped++;
      continue;
    }
    const shape = toResponseShape(o.provider, o.shape as SensorShape, secret);
    const latest = await store.latest(o.provider, o.method, o.endpoint, source);
    if (latest?.shapeHash === shapeHash(shape)) continue;
    await store.record({ provider: o.provider, method: o.method, endpoint: o.endpoint, observedAt: o.lastSeen, source, shape });
    stored++;
  }
  return { stored, dropped };
}

export interface SensorChange {
  provider: string;
  method: string;
  endpoint: string;
  /** What changed, as the shape diff says it: "status 204 → 200". */
  detail: string;
  key: string;
  /** How many accounts saw it. */
  accounts: number;
  firstSeen: string;
  /** The canary saw the same change on the same endpoint. */
  canary?: { source: string; observedAt: string };
}

/** Each change between consecutive distinct shapes of one source, by a key that is the same whichever source saw it. */
function transitions(history: StoredObservation[]): Map<string, { detail: string; at: string }> {
  const out = new Map<string, { detail: string; at: string }>();
  const ordered = [...history].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id - b.id);
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1]!;
    const after = ordered[i]!;
    if (before.shapeHash === after.shapeHash) continue;
    for (const c of diffShapes(before.shape, after.shape).changes) {
      if (c.impact === "informational") continue;
      const key = `${c.kind}:${c.pathHash ?? c.path ?? ""}:${JSON.stringify(c.from ?? null)}:${JSON.stringify(c.to ?? null)}`;
      if (!out.has(key)) out.set(key, { detail: c.detail, at: after.observedAt });
    }
  }
  return out;
}

/** Changes at least `minAccounts` accounts' sensors saw, each marked when the canary saw it too. */
export async function sensorChanges(db: Db, opts: { minAccounts?: number } = {}): Promise<SensorChange[]> {
  const min = opts.minAccounts ?? MIN_ACCOUNTS;
  const store = new PgShapeStore(db);
  const endpoints = await withService(db, (tx) =>
    tx
      .selectFrom("observations")
      .select(["provider", "method", "endpoint"])
      .where("source", "like", "sensor:%")
      .groupBy(["provider", "method", "endpoint"])
      .having(sql<number>`count(distinct source)`, ">=", min)
      .execute(),
  );
  const out: SensorChange[] = [];
  for (const e of endpoints) {
    const all = await store.history(e.provider, e.method, e.endpoint, { limit: 10_000 });
    const bySource = new Map<string, StoredObservation[]>();
    for (const o of all) bySource.set(o.source, [...(bySource.get(o.source) ?? []), o]);
    const seen = new Map<string, { detail: string; accounts: number; firstSeen: string }>();
    const canary = new Map<string, { source: string; observedAt: string }>();
    for (const [source, history] of bySource) {
      for (const [key, t] of transitions(history)) {
        if (source.startsWith("sensor:")) {
          const s = seen.get(key) ?? { detail: t.detail, accounts: 0, firstSeen: t.at };
          s.accounts++;
          if (t.at < s.firstSeen) s.firstSeen = t.at;
          seen.set(key, s);
        } else if (source.startsWith("canary:") && !canary.has(key)) canary.set(key, { source, observedAt: t.at });
      }
    }
    for (const [key, s] of seen) {
      if (s.accounts < min) continue;
      const c = canary.get(key);
      out.push({ provider: e.provider, method: e.method, endpoint: e.endpoint, detail: s.detail, key, accounts: s.accounts, firstSeen: s.firstSeen, ...(c ? { canary: c } : {}) });
    }
  }
  return out.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}
