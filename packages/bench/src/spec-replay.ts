import type { Advisory, ChangeClass } from "@shapi/core";

/**
 * Spec-history replay (execution plan P-08): diff a provider's published OpenAPI spec across a breaking release and
 * turn what a client could trip over into unverified advisory drafts, then score those against the provider's own
 * changelog. Written for Stripe's spec (form-encoded request bodies, response objects as component schemas), and used
 * for GitHub's too (P-09): JSON bodies, shared parameters under components.parameters, array responses.
 */

type Json = Record<string, unknown>;
interface OpenApi {
  info: { version: string };
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; parameters?: Record<string, Json> };
}

export interface DiffOptions {
  /**
   * Also report a status code an operation newly answers (`response-status-added`). GitHub counts a new error status
   * as breaking (403 becoming 451); Stripe doesn't, so it is off by default.
   */
  statusAdded?: boolean;
}

export type SpecChangeKind =
  | "operation-removed"
  | "response-status-removed"
  | "response-status-added"
  | "parameter-removed"
  | "parameter-required"
  | "property-removed"
  | "property-type-changed"
  | "enum-value-removed"
  | "enum-value-added"
  | "schema-removed";

export interface SpecChange {
  kind: SpecChangeKind;
  changeClass: ChangeClass;
  /** `POST /v1/payment_intents`, for a change to an operation or its request. */
  operation?: string;
  /** The component schema, for a change to a response object (`payment_intent`). */
  schema?: string;
  /** The property, parameter or field path that changed (`payment_method_types`, `card.network`). */
  field?: string;
  /** Enum values that are gone. */
  values?: string[];
  detail: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** Everything a client could trip over between two versions of a spec. */
export function diffSpecs(before: OpenApi, after: OpenApi, opts: DiffOptions = {}): SpecChange[] {
  const out: SpecChange[] = [];
  for (const [path, item] of Object.entries(before.paths)) {
    for (const method of METHODS) {
      const old = item[method] as Json | undefined;
      if (!old) continue;
      const operation = `${method.toUpperCase()} ${path}`;
      const now = after.paths[path]?.[method] as Json | undefined;
      if (!now) {
        out.push({ kind: "operation-removed", changeClass: "version-sunset", operation, detail: `${operation} is gone` });
        continue;
      }
      for (const status of Object.keys((old.responses as Json) ?? {})) {
        if (/^2/.test(status) && !((now.responses as Json) ?? {})[status]) out.push({ kind: "response-status-removed", changeClass: "status-code", operation, field: status, detail: `${operation} no longer answers ${status}` });
      }
      if (opts.statusAdded) {
        for (const status of Object.keys((now.responses as Json) ?? {})) {
          if (status !== "default" && !((old.responses as Json) ?? {})[status]) out.push({ kind: "response-status-added", changeClass: "status-code", operation, field: status, detail: `${operation} can now answer ${status}` });
        }
      }
      const [oldParams, newParams] = [requestParams(old, before), requestParams(now, after)];
      for (const [name, p] of oldParams) {
        const n = newParams.get(name);
        // A nested parameter gone with its parent is reported once, for the parent.
        const parent = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined;
        if (!n && parent && !newParams.has(parent)) continue;
        if (!n) out.push({ kind: "parameter-removed", changeClass: "required-field", operation, field: name, detail: `${operation} no longer takes ${name}` });
        else {
          if (!name.includes(".") && !p.required && n.required) out.push({ kind: "parameter-required", changeClass: "required-field", operation, field: name, detail: `${operation} now requires ${name}` });
          const gone = removedEnum(p.schema, n.schema, before, after);
          if (gone.length) out.push({ kind: "enum-value-removed", changeClass: "enum-added", operation, field: name, values: gone, detail: `${operation} no longer accepts ${name} = ${gone.join(", ")}` });
        }
      }
      // A new parameter that is required breaks every client that does not send it yet.
      for (const [name, n] of newParams) {
        if (!name.includes(".") && !oldParams.has(name) && n.required) out.push({ kind: "parameter-required", changeClass: "required-field", operation, field: name, detail: `${operation} now requires ${name}` });
      }
    }
  }
  for (const [name, old] of Object.entries(before.components.schemas)) {
    const now = after.components.schemas[name];
    if (!now) {
      out.push({ kind: "schema-removed", changeClass: "field-rename", schema: name, detail: `the ${name} object is gone` });
      continue;
    }
    diffObject(name, "", old, now, before, after, out, 0);
  }
  return out;
}

/**
 * Properties of a response object that went, changed type, or lost or gained enum values (a client switching over
 * every value it knows trips on a new one: Stripe labels those breaking too). Inline objects are followed, in
 * arrays and anyOf variants as well; $ref'd component schemas are diffed on their own.
 */
function diffObject(schema: string, prefix: string, old: Json, now: Json, a: OpenApi, b: OpenApi, out: SpecChange[], depth: number): void {
  if (depth > 4) return;
  const oldProps = propertiesOf(old);
  const newProps = propertiesOf(now);
  for (const [prop, o] of Object.entries(oldProps)) {
    const field = prefix ? `${prefix}.${prop}` : prop;
    const n = newProps[prop];
    if (!n) {
      out.push({ kind: "property-removed", changeClass: "field-rename", schema, field, detail: `${schema}.${field} is gone` });
      continue;
    }
    const [ot, nt] = [typeOf(o), typeOf(n)];
    if (ot !== nt) out.push({ kind: "property-type-changed", changeClass: "field-rename", schema, field, detail: `${schema}.${field} changed from ${ot} to ${nt}` });
    const gone = removedEnum(o, n, a, b);
    if (gone.length) out.push({ kind: "enum-value-removed", changeClass: "enum-added", schema, field, values: gone, detail: `${schema}.${field} no longer returns ${gone.join(", ")}` });
    const added = removedEnum(n, o, b, a);
    if (added.length) out.push({ kind: "enum-value-added", changeClass: "enum-added", schema, field, values: added, detail: `${schema}.${field} can now return ${added.join(", ")}` });
    // Same type, so its inner properties compare (an object that lost them all reports each one).
    if (Object.keys(propertiesOf(o)).length && ot === nt) diffObject(schema, field, o, n, a, b, out, depth + 1);
  }
}

/** The properties of an inline object, of the items of an inline array, and of every inline anyOf variant. */
function propertiesOf(s: Json | undefined): Record<string, Json> {
  if (!s || typeof s.$ref === "string") return {};
  const own = (s.properties as Record<string, Json>) ?? {};
  const items = s.items && typeof (s.items as Json).$ref !== "string" ? propertiesOf(s.items as Json) : {};
  const variants = Array.isArray(s.anyOf) ? Object.assign({}, ...(s.anyOf as Json[]).map(propertiesOf)) : {};
  return { ...variants, ...items, ...own };
}

/** A schema's type in a form that a change of it is a change a client can trip over: `string`, `ref:charge`, `string|null`. */
function typeOf(s: Json): string {
  if (typeof s.$ref === "string") return `ref:${s.$ref.split("/").pop()}`;
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map(typeOf).sort().join("|") + (s.nullable ? "|null" : "");
  return `${String(s.type ?? "any")}${s.nullable ? "|null" : ""}`;
}

function resolve(s: Json | undefined, spec: OpenApi): Json | undefined {
  if (s && typeof s.$ref === "string") return spec.components.schemas[s.$ref.split("/").pop()!];
  return s;
}

function removedEnum(o: Json | undefined, n: Json | undefined, a: OpenApi, b: OpenApi): string[] {
  const [ro, rn] = [resolve(o, a), resolve(n, b)];
  // The enum of the value, or of an array's items (`languages: ["python", …]`).
  const ev = (s: Json | undefined, spec: OpenApi): string[] | undefined => {
    if (Array.isArray(s?.enum)) return (s!.enum as unknown[]).map(String);
    return s?.type === "array" && s.items ? ev(resolve(s.items as Json, spec), spec) : undefined;
  };
  const [eo, en] = [ev(ro, a), ev(rn, b)];
  if (!eo || !en) return [];
  return eo.filter((v) => !en.includes(v));
}

/**
 * Query and path parameters, and the fields of a form or JSON request body, nested ones as dotted paths
 * (`payment_method_options.paypay.capture_method`): Stripe's nested parameters sit in inline objects and anyOf variants.
 */
function requestParams(op: Json, spec: OpenApi): Map<string, { required: boolean; schema?: Json }> {
  const out = new Map<string, { required: boolean; schema?: Json }>();
  for (const raw of (op.parameters as Json[]) ?? []) {
    // GitHub shares parameters: `{ $ref: "#/components/parameters/owner" }`.
    const p = typeof raw.$ref === "string" ? spec.components.parameters?.[raw.$ref.split("/").pop()!] : raw;
    if (p?.name) out.set(String(p.name), { required: p.required === true, schema: p.schema as Json });
  }
  const content = ((op.requestBody as Json)?.content as Record<string, Json>) ?? {};
  const walk = (s: Json | undefined, prefix: string, depth: number) => {
    if (!s || depth > 4) return;
    const required = new Set((s.required as string[]) ?? []);
    for (const [name, child] of Object.entries(propertiesOf(s))) {
      const key = prefix ? `${prefix}.${name}` : name;
      out.set(key, { required: required.has(name), schema: child });
      walk(child, key, depth + 1);
    }
  };
  for (const media of Object.values(content)) walk(resolve(media.schema as Json, spec), "", 0);
  return out;
}

/** The operations whose success response is, or lists, a component schema. */
export function operationsReturning(spec: OpenApi): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      for (const [status, res] of Object.entries((op.responses as Record<string, Json>) ?? {})) {
        if (!/^2/.test(status)) continue;
        const schema = (((res.content as Record<string, Json>) ?? {})["application/json"]?.schema as Json) ?? {};
        const refs = new Set<string>();
        const add = (s: Json | undefined) => typeof s?.$ref === "string" && refs.add(s.$ref.split("/").pop()!);
        add(schema);
        add(((schema.properties as Record<string, Json>)?.data as Json)?.items as Json);
        add(schema.items as Json);
        for (const alt of (schema.anyOf as Json[]) ?? []) add(alt);
        for (const r of refs) out.set(r, [...(out.get(r) ?? []), `${method.toUpperCase()} ${path}`]);
      }
    }
  }
  return out;
}

/* ---------- the changelog ---------- */

export interface ChangelogRow {
  /** The field, parameter or enum's field path, without its resource (`payment_method_types`, `network_data.visa.card_reference_id`). */
  field: string;
  change: string;
  /** Resources or endpoints it applies to (`PaymentIntent#create`, `Issuing.Token`). */
  resources: string[];
  /** For a row about enum values: the values. */
  values?: string[];
}

export interface ChangelogEntry {
  title: string;
  url: string;
  breaking: boolean;
  /** `api` for a REST API change; Stripe.js and other client-library changes are not about the spec. */
  category: string;
  /** The day of the version the entry belongs to (from its URL). */
  date: string;
  /** The REST API rows of the entry's Changes section: what changed, on which resources. */
  rest: ChangelogRow[];
  /** The entry's links all point at the preview API version: a preview change, which the GA spec does not carry. */
  preview?: boolean;
}

/** The rows of a release page's tables: title, link, whether Stripe labels the change breaking, and its category. */
export function parseReleasePage(markdown: string): Omit<ChangelogEntry, "rest">[] {
  const out: Omit<ChangelogEntry, "rest">[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\| \[(.+?)\]\((https:\/\/docs\.stripe\.com\/changelog\/[a-z]+\/(\d{4}-\d{2}-\d{2})\/[^)]+)\) \|[^|]*\| (Breaking|Non-breaking) \| ([a-z0-9_-]+) \|/.exec(line);
    if (m) out.push({ title: m[1]!, url: m[2]!, date: m[3]!, breaking: m[4] === "Breaking", category: m[5]! });
  }
  return out;
}

/** Whether an entry page links only to the preview API version (`?api-version=2026-09-30.preview`). */
export function previewOnly(markdown: string): boolean {
  const versions = [...markdown.matchAll(/api-version=\d{4}-\d{2}-\d{2}\.([a-z]+)/g)].map((m) => m[1]);
  return versions.length > 0 && versions.every((v) => v === "preview");
}

const ticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
const linked = (cell: string) => [...cell.matchAll(/\[([^\]]+)\]\(([^)]*)\)/g)].map((x) => ({ text: x[1]!, href: x[2]! }));

/**
 * The REST API tables of an entry page's Changes section, in Stripe's three shapes:
 * - `| Parameter | Change | Resources or endpoints |`: the field, then links to its resources;
 * - `| Field | Change | From → to |`: the resource is the field's leading capitalized segments (`Issuing.Token.…`);
 * - `| Values | Change | Enums |`: enum values, with the field in the links' anchors (`…#create_checkout_session-ui_mode`).
 */
export function parseEntryChanges(markdown: string): ChangelogRow[] {
  const section = /## Changes\s*\n([\s\S]*?)(?:\n## |$)/.exec(markdown)?.[1] ?? "";
  const rest = /#### REST API\s*\n([\s\S]*?)(?:\n#### |$)/.exec(section)?.[1] ?? "";
  const out: ChangelogRow[] = [];
  let header = "";
  for (const raw of rest.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.slice(1, -1).split(" | ").map((c) => c.trim());
    if (cells[0] && !cells[0].startsWith("`") && !cells[0].startsWith("---")) {
      // Stripe writes both "Field" and "Fields", "Value" and "Values".
      header = cells[0].toLowerCase().replace(/s$/, "");
      continue;
    }
    if (cells.length < 3 || !cells[0]?.startsWith("`")) continue;
    const change = cells[1]!;
    const links = linked(cells.slice(2).join(" | "));
    if (header === "value") {
      const field = links.map((l) => /-([a-z0-9_.]+)$/.exec(l.href)?.[1]).find(Boolean);
      if (field) out.push({ field, change, resources: links.map((l) => l.text), values: ticked(cells[0]!) });
    } else if (header === "field") {
      for (const path of ticked(cells[0]!)) {
        const parts = path.split(".");
        const at = parts.findIndex((p) => !/^[A-Z]/.test(p));
        out.push({ field: parts.slice(at < 0 ? parts.length - 1 : at).join("."), change, resources: [parts.slice(0, Math.max(at, 0)).join(".")].filter(Boolean) });
      }
    } else {
      for (const field of ticked(cells[0]!)) out.push({ field, change, resources: links.map((l) => l.text) });
    }
  }
  return out;
}

/* ---------- matching and scoring ---------- */

/** `PaymentIntent#create` → `payment_intent`; `v2.core.Account` → `v2.core.account`. */
export function resourceKey(resource: string): string {
  const base = resource.split("#")[0]!;
  return base.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const GENERIC = new Set(["v1", "v2", "core", "object", "resource", "resources"]);
const words = (text: string) => text.split(/[^a-z0-9]+/).filter((w) => w && !GENERIC.has(w)).map((w) => w.replace(/s$/, ""));

/**
 * Whether a spec change is about a changelog row: the same field (last segment), on a schema or operation whose name
 * carries the row's resource words (`Issuing.Token` → issuing, token in `issuing_network_token_visa`). A resource of
 * three or more words may miss one: Stripe's schema names drop words (`FinancialConnections.Session` →
 * `bank_connections_resource_link_account_session`).
 */
export function changeMatchesRow(c: SpecChange, row: ChangelogRow): boolean {
  const field = c.field?.split(".").pop();
  const rowField = row.field.split(".").pop();
  if (!field || !rowField || field !== rowField) return false;
  // A row about enum values matches a change of those values, not any change of the field.
  if (row.values && !(c.values ?? []).some((v) => row.values!.includes(v))) return false;
  const haystack = new Set(words(`${c.schema ?? ""} ${c.operation ?? ""}`));
  return row.resources.some((r) => {
    const need = words(resourceKey(r));
    if (!need.length) return false;
    const found = need.filter((w) => haystack.has(w)).length;
    return found === need.length || (need.length >= 3 && found >= need.length - 1);
  });
}

/** A row about Stripe's v2 APIs, which stripe/openapi does not publish. */
const v2Only = (e: ChangelogEntry) => e.rest.length > 0 && e.rest.every((r) => r.resources.length > 0 && r.resources.every((x) => /^v2\./i.test(x)));

export interface ReleaseScore {
  release: string;
  version: string;
  before: { sha: string; version: string };
  after: { sha: string; version: string };
  candidates: number;
  candidatesByKind: Record<string, number>;
  /** GA breaking REST API entries of the release's first version (Stripe.js and other client changes are left out). */
  breakingEntries: number;
  /** GA breaking entries about client libraries (Stripe.js), not the REST API: not scored. */
  clientOnly: number;
  /** Breaking entries a spec change matches field by field. */
  breakingFound: number;
  /** Breaking entries with no REST field table: a behavior change, which a spec diff cannot show. */
  behaviorOnly: number;
  /** Breaking entries about v2 APIs only, which the published spec does not cover. */
  outsideSpec: number;
  /** Breaking entries about preview APIs only, which the GA spec does not carry. */
  previewOnly: number;
  /** Breaking entries with REST rows that no spec change matches. */
  breakingMissed: number;
  /** Candidates matching a breaking entry, and candidates matching only a non-breaking one (false positives). */
  candidatesMatchingBreaking: number;
  candidatesMatchingNonBreaking: number;
  /** How many non-breaking entries those candidates come from. */
  nonBreakingEntriesMatched: number;
  missed: { title: string; url: string; reason: string }[];
}

export function scoreRelease(input: {
  release: string;
  version: string;
  before: ReleaseScore["before"];
  after: ReleaseScore["after"];
  changes: SpecChange[];
  entries: ChangelogEntry[];
}): ReleaseScore {
  const { changes, entries } = input;
  const day = input.version.slice(0, 10);
  const firstVersion = entries.filter((e) => e.date === day);
  const ga = firstVersion.filter((e) => e.category === "api");
  const breaking = ga.filter((e) => e.breaking);
  const nonBreaking = ga.filter((e) => !e.breaking);
  const clientOnly = firstVersion.filter((e) => e.breaking && e.category !== "api").length;
  const matches = (c: SpecChange, e: ChangelogEntry) => e.rest.some((r) => changeMatchesRow(c, r));
  const missed: ReleaseScore["missed"] = [];
  let found = 0;
  let behaviorOnly = 0;
  let outsideSpec = 0;
  let preview = 0;
  for (const e of breaking) {
    if (changes.some((c) => matches(c, e))) found++;
    else if (!e.rest.length) {
      behaviorOnly++;
      missed.push({ title: e.title, url: e.url, reason: "no REST field change listed: a behavior change" });
    } else if (v2Only(e)) {
      outsideSpec++;
      missed.push({ title: e.title, url: e.url, reason: "a v2 API, which stripe/openapi does not publish" });
    } else if (e.preview) {
      preview++;
      missed.push({ title: e.title, url: e.url, reason: "a preview API, which the GA spec does not carry" });
    } else missed.push({ title: e.title, url: e.url, reason: `no spec change matches ${e.rest.map((r) => `${r.field} (${r.change})`).slice(0, 3).join(", ")}` });
  }
  const candidatesMatchingBreaking = changes.filter((c) => breaking.some((e) => matches(c, e))).length;
  const candidatesMatchingNonBreaking = changes.filter((c) => !breaking.some((e) => matches(c, e)) && nonBreaking.some((e) => matches(c, e))).length;
  const nonBreakingEntriesMatched = nonBreaking.filter((e) => changes.some((c) => matches(c, e) && !breaking.some((b) => matches(c, b)))).length;
  const candidatesByKind: Record<string, number> = {};
  for (const c of changes) candidatesByKind[c.kind] = (candidatesByKind[c.kind] ?? 0) + 1;
  return {
    release: input.release,
    version: input.version,
    before: input.before,
    after: input.after,
    candidates: changes.length,
    candidatesByKind,
    breakingEntries: breaking.length,
    clientOnly,
    breakingFound: found,
    behaviorOnly,
    outsideSpec,
    previewOnly: preview,
    breakingMissed: breaking.length - found - behaviorOnly - outsideSpec - preview,
    candidatesMatchingBreaking,
    candidatesMatchingNonBreaking,
    nonBreakingEntriesMatched,
    missed,
  };
}

/* ---------- drafts ---------- */

/** An unverified advisory draft for a spec change (dashboard-only; never opens a PR until verified, C-03). */
export function draftAdvisory(c: SpecChange, ctx: { provider: string; providerName?: string; version: string; returning: Map<string, string[]>; sources: string[] }): Advisory {
  const name = ctx.providerName ?? ctx.provider;
  const ops = c.operation ? [c.operation] : (ctx.returning.get(c.schema ?? "") ?? []);
  const paths = ops.map((o) => o.split(" ")[1]!);
  const method = (c.operation?.split(" ")[0] ?? "*") as Advisory["endpoint"]["method"];
  const common = commonPrefix(paths);
  const path = paths.length === 1 ? paths[0]! : common && common !== "/" ? `${common.replace(/\/$/, "")}/**` : "/**";
  const trigger: Advisory["trigger"] =
    c.kind === "operation-removed"
      ? { any: true }
      : c.kind === "response-status-removed"
        ? { statusCodes: [Number(c.field)] }
        : c.kind === "response-status-added"
          ? // A new status (403 becoming 451) can reach every call: a person narrows the draft when verifying it.
            { any: true }
        : c.kind === "enum-value-removed" && c.schema
          ? { enums: [{ field: c.field!, values: c.values }] }
          : c.kind === "enum-value-added"
            ? // Code that compares the field at all may not handle the new values.
              { enums: [{ field: c.field! }] }
          : c.kind === "parameter-removed" || c.kind === "parameter-required" || c.kind === "enum-value-removed"
            ? { body: [{ field: c.field! }] }
            : c.kind === "schema-removed"
              ? { any: true }
              : { fields: [c.field!] };
  const slug = [ctx.provider, ctx.version.split(".")[1], c.kind, c.schema ?? c.operation, c.field].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
  return {
    id: slug,
    provider: ctx.provider,
    title: `${c.detail} in ${ctx.version}`,
    summary: `Spec-history replay found this change between ${name}'s published specs for the previous version and ${ctx.version}: ${c.detail}. Unverified: drafted from the spec alone, not yet checked against ${name}'s changelog or a live response.`,
    endpoint: { method, path },
    changeClass: c.changeClass,
    trigger,
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: ctx.version.slice(0, 10),
    severity: "medium",
    migrationNote: `Check the code that ${c.kind.startsWith("parameter") ? "sends" : "reads"} ${c.field ?? c.operation ?? c.schema} before moving to ${ctx.version}.`,
    sources: ctx.sources,
    status: "unverified",
  };
}

function commonPrefix(paths: string[]): string {
  if (!paths.length) return "";
  const parts = paths.map((p) => p.split("/"));
  const out: string[] = [];
  for (let i = 0; i < parts[0]!.length; i++) {
    const seg = parts[0]![i]!;
    if (seg.startsWith("{") || !parts.every((p) => p[i] === seg)) break;
    out.push(seg);
  }
  return out.join("/") || "/";
}
