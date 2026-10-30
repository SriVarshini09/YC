import type { Advisory } from "./advisory";
import { pathMatches } from "./matcher";
import rawSources from "../spec-sources.json";

/**
 * Advisories as OpenAPI Overlays and Arazzo workflows (execution plan S-05), for providers that publish their OpenAPI
 * spec in a repository. Each source is pinned to a commit; a spec excerpt (the operations the advisories touch, as the
 * spec has them at that commit) is what both are generated from, and what an overlay is checked to apply to.
 * - The overlay is the advisory's "after-spec": a shutdown removes the operation; a status-code change removes the
 *   retired 2xx response and adds the new one; every other change marks the operation with `x-shapi-*` extensions.
 * - The Arazzo workflow is the proving flow: call each operation the way the affected code does and check what the
 *   provider answers after the change.
 */
export interface SpecSource {
  repo: string;
  commit: string;
  files: string[];
}

export const SPEC_SOURCES: Record<string, SpecSource> = rawSources;

export const specFileUrl = (source: SpecSource, file: string) => `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${file}`;

/** An operation as the excerpt keeps it: what overlays target. */
export interface ExcerptOperation {
  operationId?: string;
  responses: Record<string, Record<string, never>>;
}

/** The operations advisories touch in one provider's spec at its pinned commit. */
export interface SpecExcerpt {
  provider: string;
  repo: string;
  commit: string;
  files: { file: string; /** The servers' path (`/v1`), which the spec's paths leave out. */ base: string; paths: Record<string, Record<string, ExcerptOperation>> }[];
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

/** The operations in a spec file that an advisory's endpoint covers, as [spec path, method]. */
export function operationsFor(advisory: Pick<Advisory, "endpoint">, file: { base: string; paths: Record<string, Record<string, unknown>> }): [string, string][] {
  const out: [string, string][] = [];
  for (const [p, item] of Object.entries(file.paths)) {
    if (!pathMatches(`${file.base}${p}`, advisory.endpoint)) continue;
    for (const m of METHODS) {
      if (!item[m]) continue;
      if (advisory.endpoint.method !== "*" && advisory.endpoint.method.toLowerCase() !== m) continue;
      out.push([p, m]);
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

const key = (k: string) => `['${k.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
const opTarget = (p: string, m: string) => `$.paths${key(p)}.${m}`;

export interface Overlay {
  overlay: "1.0.0";
  info: { title: string; version: string };
  extends: string;
  actions: { target: string; description?: string; update?: unknown; remove?: boolean }[];
}

const isShutdown = (a: Advisory) => a.changeClass === "version-sunset" && a.trigger.any === true;

/** One overlay per spec file the advisory touches (usually one). */
export function advisoryToOverlays(advisory: Advisory, excerpt: SpecExcerpt): { file: string; overlay: Overlay }[] {
  const source = SPEC_SOURCES[excerpt.provider];
  if (!source) return [];
  const out: { file: string; overlay: Overlay }[] = [];
  for (const file of excerpt.files) {
    const ops = operationsFor(advisory, file);
    if (!ops.length) continue;
    const actions: Overlay["actions"] = [];
    for (const [p, m] of ops) {
      const op = file.paths[p]![m]!;
      if (isShutdown(advisory)) {
        actions.push({ target: opTarget(p, m), description: `Shut down on ${advisory.effectiveDate}`, remove: true });
        continue;
      }
      const old = (advisory.trigger.statusCodes ?? []).filter((c) => String(c) in op.responses && /^2/.test(String(c)));
      const added = (advisory.trigger.newStatusCodes ?? []).filter((c) => !(String(c) in op.responses));
      for (const c of old) {
        if (!(advisory.trigger.newStatusCodes ?? []).includes(c)) actions.push({ target: `${opTarget(p, m)}.responses${key(String(c))}`, description: `No longer answers ${c}`, remove: true });
      }
      if (added.length) {
        actions.push({ target: `${opTarget(p, m)}.responses`, description: `Answers ${added.join(", ")} instead`, update: Object.fromEntries(added.map((c) => [String(c), { description: `Answered from ${advisory.effectiveDate} (SHAPI advisory ${advisory.id})` }])) });
      }
      actions.push({ target: opTarget(p, m), description: advisory.title, update: { "x-shapi-advisory": advisory.id, "x-shapi-change-class": advisory.changeClass, "x-shapi-effective-date": advisory.effectiveDate } });
    }
    out.push({ file: file.file, overlay: { overlay: "1.0.0", info: { title: `SHAPI advisory ${advisory.id}: ${advisory.title}`, version: advisory.effectiveDate }, extends: specFileUrl(source, file.file), actions } });
  }
  return out;
}

/** JSON pointer escaping for an Arazzo operationPath. */
const pointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const ident = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-");

/** The proving flow: one step per operation (at most 10), with what the provider answers after the change. */
export function advisoryToArazzo(advisory: Advisory, excerpt: SpecExcerpt): Record<string, unknown> | undefined {
  const source = SPEC_SOURCES[excerpt.provider];
  if (!source) return undefined;
  const files = excerpt.files.map((f) => ({ f, ops: operationsFor(advisory, f) })).filter((x) => x.ops.length);
  if (!files.length) return undefined;
  const name = (file: string) => ident(`${excerpt.provider}-${file.split("/").pop()!.replace(/\.json$/, "")}`);
  const body = advisory.trigger.body?.find((b) => b.values?.length);
  const newStatus = (advisory.trigger.newStatusCodes ?? []).find((c) => !(advisory.trigger.statusCodes ?? []).includes(c));
  const [condition, expectation] = isShutdown(advisory)
    ? ["$statusCode >= 400", `fails from ${advisory.effectiveDate}: the operation is shut down`]
    : newStatus !== undefined
      ? [`$statusCode == ${newStatus}`, `answers ${newStatus} from ${advisory.effectiveDate}`]
      : body
        ? ["$statusCode >= 400", `fails from ${advisory.effectiveDate} when the body sends ${body.field} = ${body.values![0]}`]
        : ["$statusCode == 200", `succeeds, with the changed response the advisory describes (${advisory.changeClass})`];
  const steps = files
    .flatMap(({ f, ops }) => ops.map(([p, m]) => ({ f, p, m })))
    .slice(0, 10)
    .map(({ f, p, m }, i) => ({
      stepId: ident(`call-${i + 1}`),
      description: `${m.toUpperCase()} ${f.base}${p} ${expectation}`,
      operationPath: `{$sourceDescriptions.${name(f.file)}.url}#/paths/${pointer(p)}/${m}`,
      ...(body && ["post", "put", "patch"].includes(m) ? { requestBody: { contentType: "application/json", payload: { [body.field]: body.values![0] } } } : {}),
      successCriteria: [{ condition }],
    }));
  return {
    arazzo: "1.0.1",
    info: { title: `SHAPI advisory ${advisory.id}`, summary: advisory.title, version: advisory.effectiveDate },
    sourceDescriptions: files.map(({ f }) => ({ name: name(f.file), url: specFileUrl(source, f.file), type: "openapi" })),
    workflows: [{ workflowId: ident(advisory.id), summary: `Shows the change: ${advisory.summary}`.slice(0, 500), steps }],
  };
}

/** Each JSONPath target the overlay generator writes: `$`, `.name` and `['key']` segments. */
function select(doc: unknown, target: string): { parent: Record<string, unknown>; key: string }[] {
  if (!target.startsWith("$")) throw new Error(`not a JSONPath: ${target}`);
  const keys: string[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\['((?:[^'\\]|\\.)*)'\]/y;
  for (let at = 1; at < target.length; ) {
    re.lastIndex = at;
    const m = re.exec(target);
    if (!m) throw new Error(`unsupported JSONPath: ${target}`);
    keys.push(m[1] ?? m[2]!.replace(/\\(.)/g, "$1"));
    at = re.lastIndex;
  }
  let parent: unknown = { $: doc };
  let last = "$";
  for (const k of keys) {
    const node = (parent as Record<string, unknown>)[last];
    if (typeof node !== "object" || node === null || !(k in node)) return [];
    parent = node;
    last = k;
  }
  return [{ parent: parent as Record<string, unknown>, key: last }];
}

/** Apply an overlay; `unmatched` lists the actions whose target matched nothing (an overlay that applies cleanly has none). */
export function applyOverlay<T>(doc: T, overlay: Overlay): { result: T; unmatched: string[] } {
  const result = structuredClone(doc);
  const unmatched: string[] = [];
  for (const action of overlay.actions) {
    const found = select(result, action.target);
    if (!found.length) {
      unmatched.push(action.target);
      continue;
    }
    for (const { parent, key: k } of found) {
      if (action.remove) delete parent[k];
      else if (action.update !== undefined) parent[k] = merge(parent[k], action.update);
    }
  }
  return { result, unmatched };
}

function merge(a: unknown, b: unknown): unknown {
  if (typeof a !== "object" || a === null || Array.isArray(a) || typeof b !== "object" || b === null || Array.isArray(b)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}
