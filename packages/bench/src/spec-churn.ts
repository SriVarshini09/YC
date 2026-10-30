import { diffSpecs, type SpecChange, type SpecChangeKind } from "./spec-replay";
import { wilson, type Rate } from "./metrics";

/**
 * Spec churn index (execution plan P-17): replay the APIs.guru directory's history, diff each spec against its
 * previous version, and rank providers by how often a new version breaks a client. The diff is the spec-replay
 * engine (P-08); Swagger 2.0 specs are mapped onto its OpenAPI 3 shape first.
 */

type Json = Record<string, unknown>;
type OpenApi = Parameters<typeof diffSpecs>[0];

/** What breaks a client that worked against the previous version. Added enum values and new statuses don't count. */
export const BREAKING_KINDS: ReadonlySet<SpecChangeKind> = new Set<SpecChangeKind>([
  "operation-removed",
  "response-status-removed",
  "parameter-removed",
  "parameter-required",
  "property-removed",
  "property-type-changed",
  "enum-value-removed",
  "schema-removed",
]);

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A parsed spec in the shape diffSpecs reads, or undefined when it has no paths. Swagger 2.0 keeps its schemas under
 * `definitions` and shared parameters under `parameters`, with a non-body parameter's type on the parameter itself.
 */
export function normalizeSpec(doc: unknown): OpenApi | undefined {
  if (!isObject(doc) || !isObject(doc.paths)) return undefined;
  const info = { version: String((isObject(doc.info) && doc.info.version) ?? "") };
  const paths = doc.paths as OpenApi["paths"];
  if (typeof doc.swagger === "string") {
    const swaggerParam = (p: Json): Json => (p.in === "body" || p.schema || typeof p.$ref === "string" ? p : { ...p, schema: { type: p.type, ...(p.enum ? { enum: p.enum } : {}), ...(p.items ? { items: p.items } : {}) } });
    const params = Object.fromEntries(Object.entries(isObject(doc.parameters) ? doc.parameters : {}).map(([k, v]) => [k, isObject(v) ? swaggerParam(v) : v]));
    const mapped: OpenApi["paths"] = {};
    for (const [path, item] of Object.entries(paths)) {
      if (!isObject(item)) continue;
      mapped[path] = Object.fromEntries(
        Object.entries(item).map(([method, op]) => [method, isObject(op) && Array.isArray(op.parameters) ? { ...op, parameters: (op.parameters as unknown[]).map((p) => (isObject(p) ? swaggerParam(p) : p)) } : op]),
      ) as OpenApi["paths"][string];
    }
    return { info, paths: mapped, components: { schemas: (isObject(doc.definitions) ? doc.definitions : {}) as Record<string, Json>, parameters: params as Record<string, Json> } };
  }
  const components = isObject(doc.components) ? doc.components : {};
  return {
    info,
    paths: Object.fromEntries(Object.entries(paths).filter(([, v]) => isObject(v))) as OpenApi["paths"],
    components: { schemas: (isObject(components.schemas) ? components.schemas : {}) as Record<string, Json>, parameters: (isObject(components.parameters) ? components.parameters : {}) as Record<string, Json> },
  };
}

/** The changes between two versions that break a client. */
export function breakingChanges(before: OpenApi, after: OpenApi): SpecChange[] {
  return diffSpecs(before, after).filter((c) => BREAKING_KINDS.has(c.kind));
}

/** One spec file modified in one commit, from `git log --raw --no-abbrev --format=@%H %cI`. */
export interface SpecEdit {
  commit: string;
  date: string;
  path: string;
  before: string;
  after: string;
}

const SPEC_FILE = /^APIs\/.+\/(openapi|swagger)\.(yaml|json)$/;

/** The modified spec files in a raw git log, oldest first. Added, deleted and renamed files have no previous version to diff. */
export function parseRawLog(text: string): SpecEdit[] {
  const edits: SpecEdit[] = [];
  let commit = "";
  let date = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("@")) {
      [commit, date] = line.slice(1).trim().split(" ") as [string, string];
      continue;
    }
    // :100644 100644 <old blob> <new blob> M\t<path>
    const m = /^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) M\t(.+)$/.exec(line.trim());
    if (m && SPEC_FILE.test(m[3]!)) edits.push({ commit, date, path: m[3]!, before: m[1]!, after: m[2]! });
  }
  return edits.reverse();
}

/** `APIs/googleapis.com/drive/v3/openapi.yaml`: provider `googleapis.com`, API `googleapis.com/drive`. */
export function apiOf(path: string): { provider: string; api: string } {
  const parts = path.split("/").slice(1, -2);
  return { provider: parts[0]!, api: parts.join("/") };
}

/** One spec version compared with the one before it. */
export interface VersionPair {
  path: string;
  commit: string;
  date: string;
  breaking: number;
}

export interface ProviderChurn {
  provider: string;
  apis: number;
  /** New versions compared with the one before. */
  pairs: number;
  /** New versions with at least one breaking change. */
  breakingPairs: number;
  breakingChanges: number;
  /** breakingPairs out of pairs, with its 95% Wilson interval. */
  rate: Rate;
  first: string;
  last: string;
}

/** Providers with at least `minPairs` versions compared, ranked by the low end of their breaking rate's interval. */
export function churnIndex(pairs: VersionPair[], minPairs: number): ProviderChurn[] {
  const by = new Map<string, VersionPair[]>();
  for (const p of pairs) {
    const { provider } = apiOf(p.path);
    by.set(provider, [...(by.get(provider) ?? []), p]);
  }
  return [...by.entries()]
    .filter(([, ps]) => ps.length >= Math.max(1, minPairs))
    .map(([provider, ps]) => {
      const dates = ps.map((p) => p.date).sort();
      const breakingPairs = ps.filter((p) => p.breaking > 0).length;
      return {
        provider,
        apis: new Set(ps.map((p) => apiOf(p.path).api)).size,
        pairs: ps.length,
        breakingPairs,
        breakingChanges: ps.reduce((n, p) => n + p.breaking, 0),
        rate: wilson(breakingPairs, ps.length)!,
        first: dates[0]!.slice(0, 10),
        last: dates.at(-1)!.slice(0, 10),
      };
    })
    .sort((a, b) => b.rate.low - a.rate.low || b.pairs - a.pairs || a.provider.localeCompare(b.provider));
}
