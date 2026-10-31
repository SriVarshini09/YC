/**
 * The sensor's wire format (shapi.sensor/v1): what one response looked like, without its values. Field names and
 * JSON types only: no values, no value hashes, no request path (the endpoint is the advisory's pattern), no query,
 * no request body, no credentials. The Python sensor writes the same thing (python/shapi_sensor/__init__.py).
 */

export const WIRE_VERSION = 1;

export type JsonType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export interface SensorShape {
  status: number;
  /** Headers whose values are contract signals (deprecation, sunset, API version), with their values. */
  headers: Record<string, string>;
  body: { kind: "empty" | "json" | "text"; rootType?: JsonType; fields: { path: string; types: JsonType[] }[] };
}

export interface SensorObservation {
  provider: string;
  method: string;
  /** The advisory's path pattern, never the request's own path. */
  endpoint: string;
  shape: SensorShape;
  /** How many responses had this shape since the last flush. */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface SensorBatch {
  v: typeof WIRE_VERSION;
  sdk: "node" | "python";
  observations: SensorObservation[];
}

/** Kept with their value: they say which version answered and whether it is going away. */
export const SIGNAL_HEADERS = ["anthropic-version", "api-version", "deprecation", "intuit-minor-version", "link-deprecation", "openai-version", "stripe-version", "sunset", "x-api-version", "x-github-api-version-selected", "x-shopify-api-deprecated-reason", "x-shopify-api-version"];

/** Deeper values are recorded by type only. */
const MAX_DEPTH = 32;
/** A body with more fields than this is cut off: the first ones in order are kept. */
const MAX_FIELDS = 500;

function typeOf(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as JsonType;
}

/** `a.b[].c` paths with `.`, `[` and `\` in keys escaped, as in @shapi/shapes. */
const escapeKey = (k: string) => k.replace(/[\\.[]/g, "\\$&");

/** The value-free shape of one response. */
export function sensorShape(status: number, headers: Iterable<[string, string]>, body: string): SensorShape {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    const n = name.toLowerCase();
    if (SIGNAL_HEADERS.includes(n)) kept[n] = value;
  }
  const sortedHeaders = Object.fromEntries(Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (body.trim() === "") return { status, headers: sortedHeaders, body: { kind: "empty", fields: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status, headers: sortedHeaders, body: { kind: "text", fields: [] } };
  }
  const fields = new Map<string, Set<JsonType>>();
  const walk = (v: unknown, path: string, depth: number) => {
    if (path) {
      const set = fields.get(path) ?? (fields.size < MAX_FIELDS ? new Set<JsonType>() : undefined);
      if (!set) return;
      set.add(typeOf(v));
      fields.set(path, set);
    }
    if (depth >= MAX_DEPTH) return;
    if (Array.isArray(v)) for (const item of v) walk(item, `${path}[]`, depth + 1);
    else if (v !== null && typeof v === "object") for (const [k, c] of Object.entries(v)) walk(c, path ? `${path}.${escapeKey(k)}` : escapeKey(k), depth + 1);
  };
  walk(parsed, "", 0);
  return {
    status,
    headers: sortedHeaders,
    body: {
      kind: "json",
      rootType: typeOf(parsed),
      fields: [...fields].map(([path, types]) => ({ path, types: [...types].sort() })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    },
  };
}

/** A stable key for a shape, to count identical responses together. */
export function shapeKey(s: SensorShape): string {
  return JSON.stringify([s.status, s.headers, s.body.kind, s.body.rootType ?? null, s.body.fields.map((f) => [f.path, f.types])]);
}
