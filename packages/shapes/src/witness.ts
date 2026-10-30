import { createHash } from "node:crypto";
import { HTTP_METHODS } from "@shapi/core";
import { z } from "zod";
import { MAX_DEPTH, classify, typeOf, type RawResponse } from "./shape";

/**
 * The shape witness (execution plan A-01): one value-free record of one HTTP response, the same for every source
 * of evidence (the canary, replayed recordings, test fixtures and, later, opt-in customer traffic), so a change seen
 * anywhere can be compared with a change seen everywhere.
 *
 * - Values are zeroed: a field records its JSON types and, for strings, a format class (uuid, date, url…), never a
 *   value. Enum values are kept in clear only for paths the allowlist names.
 * - Keys outside the allowlist are dropped and counted (it fails closed: no allowlist, no body keys).
 * - Objects whose keys are data (ids, dates, emails, or many keys) collapse to a map, written `{}`: their keys are
 *   never recorded.
 * - `shapeId` is the sha256 of the canonical witness without `observedAt`, `source` and itself, so the same response
 *   gives the same id on every run and from every source.
 */
export const WITNESS_SCHEMA = "https://shapi.dev/schema/witness-v1.json";

/** The witness format as JSON Schema, published at WITNESS_SCHEMA (site/public/schema/witness-v1.json). */
export function witnessJsonSchema(): Record<string, unknown> {
  const { $schema, ...rules } = z.toJSONSchema(WitnessSchema, { io: "input" }) as Record<string, unknown>;
  return { $schema, $id: WITNESS_SCHEMA, title: "SHAPI shape witness", description: "One value-free record of one HTTP response from a third-party API: its status, contract headers, deprecation dates and the typed key paths of its body. See https://shapi.dev.", ...rules };
}

export const WITNESS_SOURCES = ["canary", "replay", "fixture", "fleet"] as const;
export type WitnessSource = (typeof WITNESS_SOURCES)[number];

export const WitnessSchema = z.object({
  schema: z.literal(WITNESS_SCHEMA),
  provider: z.string().min(1),
  /** The API version the provider says it answered with (a version header), or the one the request asked for. */
  apiVersion: z.string().nullable(),
  method: z.enum(HTTP_METHODS),
  /** The endpoint as in the provider's docs, `{param}` for path parameters. */
  pathTemplate: z.string().startsWith("/"),
  status: z.number().int(),
  /** Names of the contract-relevant headers present (volatile and rate-limit headers left out). */
  headerNames: z.array(z.string()),
  /** RFC 9745 Deprecation, as an ISO date-time, when the response carries it. */
  deprecation: z.string().nullable(),
  /** RFC 8594 Sunset, as an ISO date-time, when the response carries it. */
  sunset: z.string().nullable(),
  body: z.object({
    kind: z.enum(["empty", "json", "text"]),
    /** Key path (`$.data[].id`, `$.rates{}.value`) to its type: `string:uuid`, `integer`, `null|string:datetime`, `enum{closed,open}`. */
    fields: z.record(z.string(), z.string()),
  }),
  /** Paths whose objects were collapsed to maps. */
  mapCollapsed: z.array(z.string()),
  /** How many distinct body paths were left out because the allowlist does not name them. */
  dropped: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(),
  source: z.enum(WITNESS_SOURCES),
  shapeId: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Witness = z.infer<typeof WitnessSchema>;

/**
 * Which body keys a witness may record. `keys: "*"` records every key (SHAPI's own canary accounts); a list records
 * only those paths and the objects on the way to them. `enums` names the paths whose string values may be kept in
 * clear; every other value is zeroed.
 */
export interface WitnessAllowlist {
  keys: "*" | string[];
  enums?: string[];
}

export interface WitnessContext {
  provider: string;
  method: Witness["method"];
  pathTemplate: string;
  source: WitnessSource;
  observedAt: string;
  allow: WitnessAllowlist;
  /** The version the request asked for, when no response header names one (QuickBooks' minorversion query). */
  apiVersion?: string;
}

/** Response headers that name the API version that answered. */
const VERSION_HEADERS = [
  "x-github-api-version-selected", "stripe-version", "openai-version", "anthropic-version", "intuit-minor-version",
  "x-shopify-api-version", "api-version", "x-api-version",
];

/** Headers that change per request, per token or per proxy, and say nothing about the contract. */
const VOLATILE = /^(date|age|etag|last-modified|expires|set-cookie|cf-ray|server-timing|x-request-id|request-id|x-github-request-id|x-runtime|x-served-by|x-cache|x-cache-hits|x-timer|content-length|connection|keep-alive|via|report-to|nel|idempotency-key|original-request|transfer-encoding|accept-ranges|content-encoding|vary|alt-svc|cache-control|github-authentication-token-expiration|x-ratelimit.*|ratelimit.*|retry-after)$/;

/** Over this many keys an object is a map, whatever its keys look like. */
export const MAP_MIN_KEYS = 32;
const DATA_KEY_CLASSES = new Set(["uuid", "date", "datetime", "email", "url", "id"]);
const STRING_CLASSES = new Set(["datetime", "date", "uuid", "url", "email", "id", "token", "text"]);

export function toWitness(res: RawResponse, ctx: WitnessContext): Witness {
  const headers = new Map<string, string>();
  for (const [name, value] of res.headers instanceof Headers ? res.headers.entries() : Object.entries(res.headers)) headers.set(name.toLowerCase(), value);

  const fields = new Map<string, Field>();
  const collapsed = new Set<string>();
  const dropped = new Set<string>();
  const text = res.body ?? "";
  let kind: Witness["body"]["kind"] = text.trim() === "" ? "empty" : "text";
  if (kind === "text") {
    try {
      const parsed: unknown = JSON.parse(text);
      kind = "json";
      const allowed = allowedPaths(ctx.allow);
      const visit = (value: unknown, path: string, depth: number) => {
        if (path !== "$") {
          if (allowed && !allowed.has(path)) {
            dropped.add(path);
            return;
          }
          add(fields, path, value, ctx.allow.enums?.includes(path) ?? false);
        }
        if (depth >= MAX_DEPTH) return;
        if (Array.isArray(value)) for (const item of value) visit(item, `${path}[]`, depth + 1);
        else if (value !== null && typeof value === "object") {
          const entries = Object.entries(value);
          if (isMap(entries.map(([k]) => k))) {
            collapsed.add(path);
            for (const [, child] of entries) visit(child, `${path}{}`, depth + 1);
          } else for (const [key, child] of entries) visit(child, `${path}.${escape(key)}`, depth + 1);
        }
      };
      add(fields, "$", parsed, false);
      visit(parsed, "$", 0);
    } catch {
      kind = "text";
    }
  }

  const body: Witness["body"] = { kind, fields: Object.fromEntries([...fields.entries()].sort(([a], [b]) => cmp(a, b)).map(([p, f]) => [p, describe(f)])) };
  const witness: Omit<Witness, "shapeId"> = {
    schema: WITNESS_SCHEMA,
    provider: ctx.provider,
    apiVersion: VERSION_HEADERS.map((h) => headers.get(h)).find(Boolean) ?? ctx.apiVersion ?? null,
    method: ctx.method,
    pathTemplate: ctx.pathTemplate,
    status: res.status,
    headerNames: [...headers.keys()].filter((h) => !VOLATILE.test(h)).sort(),
    deprecation: httpDate(headers.get("deprecation")),
    sunset: httpDate(headers.get("sunset")),
    body,
    mapCollapsed: [...collapsed].sort(),
    dropped: dropped.size,
    observedAt: ctx.observedAt,
    source: ctx.source,
  };
  return { ...witness, shapeId: shapeId(witness) };
}

/** sha256 of the witness's canonical JSON, leaving out when and from where it was observed. */
export function shapeId(witness: Omit<Witness, "shapeId"> | Witness): string {
  const rest: Partial<Witness> = { ...witness };
  delete rest.observedAt;
  delete rest.source;
  delete rest.shapeId;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

interface Field {
  types: Set<string>;
  classes: Set<string>;
  /** Clear values, for an allowlisted enum path. */
  values?: Set<string>;
}

function add(fields: Map<string, Field>, path: string, value: unknown, keepValue: boolean): void {
  let f = fields.get(path);
  if (!f) fields.set(path, (f = { types: new Set(), classes: new Set(), ...(keepValue ? { values: new Set<string>() } : {}) }));
  const type = typeOf(value);
  f.types.add(type);
  if (type === "string") {
    const cls = classify(value);
    if (cls && STRING_CLASSES.has(cls)) f.classes.add(cls);
    if (f.values) f.values.add(value as string);
  }
}

/** `null|string:uuid`, `integer`, `enum{closed,open}`. */
function describe(f: Field): string {
  if (f.values && f.values.size > 0 && [...f.types].every((t) => t === "string" || t === "null")) {
    const e = `enum{${[...f.values].sort().join(",")}}`;
    return f.types.has("null") ? `null|${e}` : e;
  }
  return [...f.types]
    .sort()
    .map((t) => (t === "string" && f.classes.size > 0 ? `string:${[...f.classes].sort().join("+")}` : t))
    .join("|");
}

/** Whether an object's keys are data rather than names: many keys, or mostly ids, dates, emails or numbers. */
function isMap(keys: string[]): boolean {
  if (keys.length > MAP_MIN_KEYS) return true;
  if (keys.length < 3) return false;
  const data = keys.filter((k) => /^-?\d+$/.test(k) || DATA_KEY_CLASSES.has(classify(k) ?? ""));
  return data.length / keys.length >= 0.8;
}

/** The allowed paths with every object on the way to them; undefined when every key is allowed. */
function allowedPaths(allow: WitnessAllowlist): Set<string> | undefined {
  if (allow.keys === "*") return undefined;
  const out = new Set<string>();
  for (const path of allow.keys) {
    // "$.a.b[].c" allows "$.a", "$.a.b", "$.a.b[]" and itself.
    for (let i = 2; i <= path.length; i++) if (i === path.length || path[i] === "." || path[i] === "[" || path[i] === "{") out.add(path.slice(0, i));
  }
  return out;
}

function escape(key: string): string {
  return key.replace(/[\\.[\]{}]/g, "\\$&");
}

/** An RFC 9745 structured date (`@1735689600`) or an HTTP-date, as ISO; anything else as sent. */
function httpDate(value: string | undefined): string | null {
  if (!value) return null;
  const structured = /^@(-?\d+)$/.exec(value.trim());
  const ms = structured ? Number(structured[1]) * 1000 : Date.parse(value);
  return Number.isNaN(ms) ? value.slice(0, 100) : new Date(ms).toISOString();
}

/** JSON with object keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(cmp)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
