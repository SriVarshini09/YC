import { createHash, createHmac } from "node:crypto";
import { z } from "zod";

export const JSON_TYPES = ["array", "boolean", "integer", "null", "number", "object", "string"] as const;
export type JsonType = (typeof JSON_TYPES)[number];

/** Coarse class of a value. Classes describe values without storing them. */
export const VALUE_CLASSES = [
  "datetime", "date", "uuid", "url", "email", "id", "token", "text",
  "positive", "negative", "zero", "true", "false",
] as const;
export type ValueClass = (typeof VALUE_CLASSES)[number];

/** Deeper values are recorded by type only: their contents are not walked (a deeply nested body would overflow the stack). */
export const MAX_DEPTH = 64;

/** Above this many distinct token values a field is free text, not an enum. */
export const MAX_ENUM_VALUES = 50;

export const FieldShapeSchema = z.object({
  /**
   * Field path, dot-separated, array items as "[]"; a key holding ".", "[" or "\\" has them escaped
   * with a backslash (see pathSegments). Omitted when the shape is redacted.
   */
  path: z.string().optional(),
  /** HMAC of the path with the provider salt; stable across observations. */
  pathHash: z.string(),
  types: z.array(z.enum(JSON_TYPES)),
  classes: z.array(z.enum(VALUE_CLASSES)),
  /** How many times the field appeared (more than once inside arrays). */
  occurrences: z.number().int().nonnegative(),
  /** Share of occurrences that were null. */
  nullRate: z.number().min(0).max(1),
  /** Array lengths seen, for array fields. */
  arrayLength: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
  /** HMACs of distinct token values (enum candidates), never the values themselves. */
  valueHashes: z.array(z.string()).optional(),
});
export type FieldShape = z.infer<typeof FieldShapeSchema>;

export const ResponseShapeSchema = z.object({
  status: z.number().int(),
  /** Allowlisted headers whose values describe the contract, not the payload. */
  headers: z.record(z.string(), z.string()),
  /** Names of the other non-volatile headers present. */
  headerNames: z.array(z.string()),
  body: z.object({
    kind: z.enum(["empty", "json", "text"]),
    rootType: z.enum(JSON_TYPES).optional(),
    fields: z.array(FieldShapeSchema),
  }),
});
export type ResponseShape = z.infer<typeof ResponseShapeSchema>;

export interface RawResponse {
  status: number;
  headers: Headers | Record<string, string>;
  body: string | null | undefined;
}

export interface InferOptions {
  /** Per-provider salt for path and value hashes. */
  salt: string;
}

/** Headers kept with their value: they carry versioning and deprecation signals. */
const VALUE_HEADERS = new Set([
  "content-type", "deprecation", "sunset", "link-deprecation", "x-shopify-api-deprecated-reason", "x-github-api-version-selected", "stripe-version",
  "x-api-version", "api-version", "openai-version", "anthropic-version", "intuit-minor-version",
]);

/** Headers that change on every request and say nothing about the contract. */
const VOLATILE_HEADERS = new Set([
  "date", "age", "etag", "last-modified", "expires", "set-cookie", "cf-ray", "server-timing", "x-request-id",
  "request-id", "x-github-request-id", "x-runtime", "x-served-by", "x-cache", "x-cache-hits", "x-timer",
  "content-length", "connection", "keep-alive", "via", "report-to", "nel", "idempotency-key", "original-request",
  // transport and caching: vary with chunking, compression and proxies, not with the API contract
  "transfer-encoding", "accept-ranges", "content-encoding", "vary", "alt-svc", "cache-control",
  // token metadata: present only on authenticated calls, value changes per token
  "github-authentication-token-expiration",
]);

export function providerSalt(provider: string, secret: string): string {
  return createHmac("sha256", secret).update(provider).digest("hex");
}

function hmac(salt: string, value: string): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 16);
}

/** Infer the shape of one HTTP response. Payload values are classified and hashed, never kept. */
export function inferShape(res: RawResponse, opts: InferOptions): ResponseShape {
  const headers: Record<string, string> = {};
  const headerNames: string[] = [];
  const entries = res.headers instanceof Headers ? [...res.headers.entries()] : Object.entries(res.headers);
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (VALUE_HEADERS.has(name)) headers[name] = name === "content-type" ? value.split(";")[0]!.trim() : value;
    else if (!VOLATILE_HEADERS.has(name) && !name.startsWith("x-ratelimit") && !name.startsWith("ratelimit")) headerNames.push(name);
  }

  const text = res.body ?? "";
  let body: ResponseShape["body"];
  if (text.trim() === "") {
    body = { kind: "empty", fields: [] };
  } else {
    let parsed: unknown;
    let isJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      isJson = false;
    }
    if (isJson) {
      const acc = new Map<string, Acc>();
      walk(parsed, "", acc, 0);
      body = { kind: "json", rootType: typeOf(parsed), fields: finish(acc, opts.salt) };
    } else {
      body = { kind: "text", fields: [] };
    }
  }

  return {
    status: res.status,
    headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => cmp(a, b))),
    headerNames: [...new Set(headerNames)].sort(),
    body,
  };
}

interface Acc {
  types: Set<JsonType>;
  classes: Set<ValueClass>;
  occurrences: number;
  nulls: number;
  lengths?: { min: number; max: number };
  tokens: Set<string>;
  textValues: number;
}

function walk(value: unknown, path: string, acc: Map<string, Acc>, depth: number): void {
  if (path !== "") record(value, path, acc);
  if (depth >= MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, acc, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, path === "" ? escapeKey(key) : `${path}.${escapeKey(key)}`, acc, depth + 1);
  }
}

/** A key as one path segment: `{"a.b": 1}` is "a\.b", so it never reads as `{a: {b: 1}}`. */
export function escapeKey(key: string): string {
  return key.replace(/[\\.[]/g, "\\$&");
}

/** "a.b[].c" → ["a", "b", "[]", "c"]; "[].id" → ["[]", "id"]; "a\.b" → ["a.b"]. Keys come back unescaped. */
export function pathSegments(path: string): string[] {
  const out: string[] = [];
  let key = "";
  let pending = false;
  const flush = () => {
    if (pending) out.push(key);
    key = "";
    pending = false;
  };
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (c === "\\" && i + 1 < path.length) {
      key += path[++i];
      pending = true;
    } else if (c === ".") flush();
    else if (c === "[" && path[i + 1] === "]") {
      flush();
      out.push("[]");
      i++;
    } else {
      key += c;
      pending = true;
    }
  }
  flush();
  return out;
}

function record(value: unknown, path: string, acc: Map<string, Acc>): void {
  let a = acc.get(path);
  if (!a) acc.set(path, (a = { types: new Set(), classes: new Set(), occurrences: 0, nulls: 0, tokens: new Set(), textValues: 0 }));
  a.occurrences++;
  const type = typeOf(value);
  a.types.add(type);
  if (type === "null") a.nulls++;
  if (Array.isArray(value)) {
    a.lengths = a.lengths
      ? { min: Math.min(a.lengths.min, value.length), max: Math.max(a.lengths.max, value.length) }
      : { min: value.length, max: value.length };
  }
  const cls = classify(value);
  if (cls) a.classes.add(cls);
  if (cls === "token" && typeof value === "string") a.tokens.add(value);
}

function finish(acc: Map<string, Acc>, salt: string): FieldShape[] {
  return [...acc.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([path, a]) => {
      const field: FieldShape = {
        path,
        pathHash: hmac(salt, path),
        types: [...a.types].sort(),
        classes: [...a.classes].sort(),
        occurrences: a.occurrences,
        nullRate: round(a.nulls / a.occurrences),
      };
      if (a.lengths) field.arrayLength = a.lengths;
      if (a.tokens.size > 0 && a.tokens.size <= MAX_ENUM_VALUES) {
        field.valueHashes = [...a.tokens].map((v) => hmac(salt, `${path}=${v}`)).sort();
      }
      return field;
    });
}

export function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "object";
}

export function classify(value: unknown): ValueClass | undefined {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value > 0 ? "positive" : value < 0 ? "negative" : "zero";
  if (typeof value !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) return "datetime";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "uuid";
  if (/^https?:\/\//i.test(value)) return "url";
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return "email";
  if (/^[a-z]{2,8}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}$/.test(value) || /^\d{5,}$/.test(value) || /^[0-9a-f]{20,}$/i.test(value)) return "id";
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value)) return "token";
  return "text";
}

/** Hash of the structural part of a shape: ignores counts, rates and lengths that vary between identical contracts. */
export function shapeHash(shape: ResponseShape): string {
  const structural = {
    status: shape.status,
    // Sorted here too: a shape read back from Postgres JSONB can have its keys in another order.
    headers: Object.fromEntries(Object.entries(shape.headers).sort(([a], [b]) => cmp(a, b))),
    headerNames: shape.headerNames,
    body: {
      kind: shape.body.kind,
      rootType: shape.body.rootType ?? null,
      fields: shape.body.fields.map((f) => [f.pathHash, f.types, f.classes, f.nullRate > 0, f.valueHashes ?? null]),
    },
  };
  return createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

/** Drop clear-text field paths, keeping only their hashes (for shapes observed in tenant traffic). */
export function redactShape(shape: ResponseShape): ResponseShape {
  const fields = shape.body.fields.map((f) => {
    const copy = { ...f };
    delete copy.path;
    return copy;
  });
  return { ...shape, body: { ...shape.body, fields } };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
