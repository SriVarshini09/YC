import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HTTP_METHODS } from "./providers";

export const NameValueSchema = z.object({
  name: z.string(),
  /** Statically known value, with unknown parts as {name}; null when unknown. */
  value: z.string().nullable(),
});
export type NameValue = z.infer<typeof NameValueSchema>;

/** What a call site's code depends on. */
export const SurfaceSchema = z.object({
  /** Response body field paths read, dot-separated; array elements as "[]". */
  fields: z.array(z.string()),
  /** Status codes the code compares against. */
  statusCodes: z.array(z.number().int()),
  /** Branches on `response.ok`. */
  checksOk: z.boolean(),
  /** String values response fields are compared against. */
  enums: z.array(z.object({ field: z.string(), values: z.array(z.string()) })),
  /** Request headers set, names lowercased (API version pins live here). */
  headers: z.array(NameValueSchema),
  /** Request query parameters. */
  query: z.array(NameValueSchema),
  /** Response headers read, names lowercased. */
  responseHeaders: z.array(z.string()),
});
export type Surface = z.infer<typeof SurfaceSchema>;

export const CallSiteSchema = z.object({
  /** Repo-relative POSIX path. */
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  provider: z.string().nullable(),
  kind: z.enum(["http", "sdk"]),
  /** HTTP library (fetch, axios, got, undici, ky, node-fetch) or SDK package name. */
  client: z.string(),
  /** SDK method chain, for example "rest.actions.createWorkflowDispatch". */
  operation: z.string().optional(),
  method: z.enum(HTTP_METHODS).nullable(),
  host: z.string().nullable(),
  /** Path with dynamic segments as {name} or {}, query string removed. */
  endpoint: z.string().nullable(),
  /** True when provider, method and endpoint are all known. */
  resolved: z.boolean(),
  surface: SurfaceSchema,
});
export type CallSite = z.infer<typeof CallSiteSchema>;
export type CallKind = CallSite["kind"];

export const LockedCallSiteSchema = z.object({ id: z.string().regex(/^[0-9a-f]{12}$/) }).extend(CallSiteSchema.shape);
export type LockedCallSite = z.infer<typeof LockedCallSiteSchema>;

export const ApiLockSchema = z.object({
  lockfileVersion: z.literal(1),
  generator: z.string(),
  providers: z.array(
    z.object({
      id: z.string(),
      callSites: z.number().int().nonnegative(),
      /** SDK packages in package.json that point at this provider. */
      declaredBy: z.array(z.string()),
    }),
  ),
  callSites: z.array(LockedCallSiteSchema),
});
export type ApiLock = z.infer<typeof ApiLockSchema>;

export const LOCKFILE_VERSION = 1;

export function callSiteId(site: Pick<CallSite, "file" | "line" | "column" | "method" | "endpoint">): string {
  return createHash("sha256")
    .update(`${site.file}:${site.line}:${site.column}:${site.method ?? "?"}:${site.endpoint ?? "?"}`)
    .digest("hex")
    .slice(0, 12);
}

export interface LockInput {
  callSites: CallSite[];
  declared: { provider: string; package: string }[];
}

/** Build an api.lock: call sites sorted by file and position, providers sorted by id, no timestamps or absolute paths. */
export function createApiLock(input: LockInput, generator: string): ApiLock {
  const callSites = [...input.callSites]
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || a.column - b.column)
    .map((site) => ({ id: callSiteId(site), ...site }));

  const providers = new Map<string, { callSites: number; declaredBy: Set<string> }>();
  const entry = (id: string) => {
    let e = providers.get(id);
    if (!e) providers.set(id, (e = { callSites: 0, declaredBy: new Set() }));
    return e;
  };
  for (const site of callSites) if (site.provider) entry(site.provider).callSites++;
  for (const d of input.declared) entry(d.provider).declaredBy.add(d.package);

  return ApiLockSchema.parse({
    lockfileVersion: LOCKFILE_VERSION,
    generator,
    providers: [...providers]
      .sort(([a], [b]) => cmp(a, b))
      .map(([id, e]) => ({ id, callSites: e.callSites, declaredBy: [...e.declaredBy].sort() })),
    callSites,
  });
}

/** Byte-stable JSON: keys in schema order (zod rebuilds objects in shape order), two-space indent, trailing newline. */
export function serializeApiLock(lock: ApiLock): string {
  return JSON.stringify(ApiLockSchema.parse(lock), null, 2) + "\n";
}

export function writeApiLock(file: string, lock: ApiLock): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, serializeApiLock(lock));
}

export function apiLockJsonSchema(): unknown {
  return z.toJSONSchema(ApiLockSchema);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
