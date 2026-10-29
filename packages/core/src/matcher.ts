import { SEVERITY_RANK, type Advisory, type EndpointPattern, type Trigger } from "./advisory";
import type { ApiLock, LockedCallSite } from "./lockfile";

export interface Finding {
  advisory: Advisory;
  callSite: LockedCallSite;
  /** Why this call site is (or is not) hit, in plain words. */
  reasons: string[];
}

export interface UpcomingDeadline {
  advisory: Advisory;
  /** Whole days from today to the effective date, both as UTC calendar days (0 on the day itself). */
  daysUntil: number;
  /** Call sites that call the advisory's endpoint, affected or exposed. */
  callSites: number;
}

export interface MatchResult {
  /** The call site depends on exactly what changed. */
  affected: Finding[];
  /** The call site calls the endpoint but does not depend on what changed. */
  exposed: Finding[];
  /**
   * The path is built at runtime where the change is narrower than the call: `/v24.0/{endpoint}`
   * against Meta's ad-account paths (`/v24.0/act_…`). Affected if the runtime value reaches the changed endpoint.
   * Also a matching path whose HTTP method or host SHAPI cannot tell (a URL no recognized client sends).
   */
  possible: Finding[];
  /** Advisories for providers in this repo that take effect within the horizon. */
  upcoming: UpcomingDeadline[];
}

export interface MatchOptions {
  now?: Date;
  horizonDays?: number;
}

const DAY_MS = 86_400_000;

/** Intersect advisories with an api.lock. */
export function matchAdvisories(lock: ApiLock, advisories: Advisory[], options: MatchOptions = {}): MatchResult {
  const now = options.now ?? new Date();
  const horizon = options.horizonDays ?? 90;
  const affected: Finding[] = [];
  const exposed: Finding[] = [];
  const possible: Finding[] = [];
  const hitsPerAdvisory = new Map<string, number>();

  for (const advisory of advisories) {
    for (const callSite of lock.callSites) {
      if (!endpointMatches(callSite, advisory)) {
        const why = mayMatchReason(callSite, advisory);
        if (why && triggerReasons(callSite, advisory.trigger).length > 0) possible.push({ advisory, callSite, reasons: [why] });
        continue;
      }
      hitsPerAdvisory.set(advisory.id, (hitsPerAdvisory.get(advisory.id) ?? 0) + 1);
      const reasons = triggerReasons(callSite, advisory.trigger);
      if (reasons.length > 0) affected.push({ advisory, callSite, reasons });
      else exposed.push({ advisory, callSite, reasons: [`calls ${describe(callSite)} but does not depend on the changed behavior`] });
    }
  }

  const present = new Set(lock.providers.map((p) => p.id));
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const upcoming = advisories
    .map((advisory) => ({
      advisory,
      daysUntil: Math.round((Date.parse(advisory.effectiveDate) - today) / DAY_MS),
      callSites: hitsPerAdvisory.get(advisory.id) ?? 0,
    }))
    .filter((u) => present.has(u.advisory.provider) && u.daysUntil >= 0 && u.daysUntil <= horizon)
    .sort((a, b) => a.daysUntil - b.daysUntil || cmp(a.advisory.id, b.advisory.id));

  return { affected: affected.sort(byFinding), exposed: exposed.sort(byFinding), possible: possible.sort(byFinding), upcoming };
}

export function endpointMatches(site: LockedCallSite, advisory: Advisory): boolean {
  const pattern = advisory.endpoint;
  if (site.provider !== advisory.provider || site.endpoint === null) return false;
  if (pattern.method !== "*" && site.method !== pattern.method) return false;
  if (pattern.hosts && !(site.host && pattern.hosts.includes(site.host))) return false;
  return pathMatches(site.endpoint, pattern);
}

/**
 * The call site may reach the changed endpoint, but something the pattern needs is unknown: the HTTP
 * method or host (a URL that no recognized client sends, an SDK whose host is per-customer), or a
 * runtime segment where the pattern is narrower than "any value". Literal segments still have to agree.
 */
export function endpointMayMatch(site: LockedCallSite, advisory: Advisory): boolean {
  return mayMatchReason(site, advisory) !== undefined;
}

function mayMatchReason(site: LockedCallSite, advisory: Advisory): string | undefined {
  const pattern = advisory.endpoint;
  if (site.provider !== advisory.provider || site.endpoint === null) return undefined;
  if (pattern.method !== "*" && site.method !== null && site.method !== pattern.method) return undefined;
  if (pattern.hosts && site.host && !pattern.hosts.includes(site.host)) return undefined;
  if (pathMatches(site.endpoint, pattern)) {
    // The path matches, so only the method or the host kept it from matching outright.
    const unknown = [
      ...(pattern.method !== "*" && site.method === null ? [`the method (affected if it is ${pattern.method})`] : []),
      ...(pattern.hosts && site.host === null ? [`the host (affected if it is ${pattern.hosts.join(" or ")})`] : []),
    ];
    return unknown.length ? `calls ${describe(site)}, but SHAPI cannot tell ${unknown.join(" or ")}` : undefined;
  }
  return runtimePathMayMatch(site.endpoint, pattern.path)
    ? `builds the path at runtime (${describe(site)}); affected if it reaches ${pattern.path}`
    : undefined;
}

function runtimePathMayMatch(endpoint: string, patternPath: string): boolean {
  if (!/\{[^}]*\}/.test(endpoint)) return false;
  // Evidence, not just "anything could match": a literal segment of the pattern (Meta's "v24.0") has to
  // appear in the known part of the path, before the first runtime segment.
  const known = segments(endpoint);
  const runtimeAt = known.findIndex(isRuntime);
  const literals = segments(patternPath).filter((p) => !/[*{]/.test(p));
  if (!literals.some((l) => known.slice(0, runtimeAt < 0 ? known.length : runtimeAt).includes(l))) return false;
  return segmentsMayMatch(known, segments(patternPath));
}

const segments = (p: string) => p.split("/").filter(Boolean);
const isRuntime = (seg: string) => /^\{[^}]*\}$/.test(seg);

function segmentsMayMatch(site: string[], pattern: string[]): boolean {
  if (pattern.length === 0) return site.length === 0;
  const [p, ...prest] = pattern as [string, ...string[]];
  if (p === "**") return segmentsMayMatch(site, prest) || (site.length > 0 && segmentsMayMatch(site.slice(1), pattern));
  if (site.length === 0) return false;
  const [s, ...srest] = site as [string, ...string[]];
  // A runtime segment at the end can hold several segments ("act_1/campaigns").
  if (isRuntime(s)) return srest.length === 0 || segmentsMayMatch(srest, prest);
  if (!pathMatches(`/${s}`, { path: `/${p}` })) return false;
  return segmentsMayMatch(srest, prest);
}

/**
 * Pattern `{name}` matches one segment, `*` matches within a segment, `**` any
 * number of segments. A call-site parameter (`{owner}`, `{}`) stands for an
 * unknown value, so it matches a pattern parameter or wildcard but not a literal.
 */
export function pathMatches(endpoint: string, pattern: Pick<EndpointPattern, "path">): boolean {
  const sample = endpoint.replace(/\{[^}]*\}/g, "\u0000");
  let re = "";
  const src = pattern.path;
  for (let i = 0; i < src.length; ) {
    if (src.startsWith("/**", i)) {
      re += "(?:/.*)?";
      i += 3;
    } else if (src.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (src[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (src[i] === "{") {
      const end = src.indexOf("}", i);
      re += "[^/]+";
      i = end < 0 ? src.length : end + 1;
    } else {
      re += src[i]!.replace(/[.+?^$()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}/?$`).test(sample);
}

function triggerReasons(site: LockedCallSite, trigger: Trigger): string[] {
  const s = site.surface;
  const reasons: string[] = [];
  const handlesNew = (trigger.newStatusCodes ?? []).length > 0 && trigger.newStatusCodes!.every((c) => s.statusCodes.includes(c));
  for (const code of trigger.statusCodes ?? []) {
    if (s.statusCodes.includes(code) && !handlesNew) reasons.push(`compares the response status to ${code}`);
  }
  for (const field of trigger.fields ?? []) {
    const read = s.fields.filter((f) => f === field || f.startsWith(`${field}.`) || f.startsWith(`${field}[]`));
    if (read.length) reasons.push(`reads ${read.join(", ")}`);
  }
  for (const { field, values } of trigger.enums ?? []) {
    const e = s.enums.find((x) => x.field === field);
    const hit = e && (values ? e.values.filter((v) => values.includes(v)) : e.values);
    if (hit?.length) reasons.push(`compares ${field} to ${hit.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  for (const h of trigger.headers ?? []) {
    const set = s.headers.find((x) => x.name === h.name.toLowerCase());
    if (set && (!h.values || (set.value !== null && h.values.includes(set.value)))) reasons.push(`sends ${set.name}: ${set.value ?? "(dynamic)"}`);
  }
  for (const q of trigger.query ?? []) {
    const p = s.query.find((x) => x.name === q.name);
    if (!p) continue;
    if (q.below !== undefined) {
      if (p.value !== null && Number(p.value) < q.below) reasons.push(`sends ${p.name}=${p.value} (below ${q.below})`);
    } else if (q.values) {
      const hit = p.value === null ? [] : p.value.split(",").map((v) => v.trim()).filter((v) => q.values!.includes(v));
      if (hit.length) reasons.push(`sends ${p.name}=${hit.join(",")}`);
    } else reasons.push(`sends ${p.name}=${p.value ?? "(dynamic)"}`);
  }
  for (const b of trigger.body ?? []) {
    const set = (s.body ?? []).find((x) => x.name === b.field);
    if (!set) continue;
    if (!b.values) reasons.push(`sends ${set.name} in the request body`);
    else if (set.value !== null && b.values.includes(set.value)) reasons.push(`sends ${set.name}: ${JSON.stringify(set.value)} in the request body`);
  }
  if (trigger.any) reasons.push(`calls ${describe(site)}`);
  return reasons;
}

function describe(site: LockedCallSite): string {
  return `${site.method ?? "?"} ${site.endpoint ?? "?"}`;
}

function byFinding(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.advisory.severity] - SEVERITY_RANK[b.advisory.severity] ||
    cmp(a.callSite.file, b.callSite.file) ||
    a.callSite.line - b.callSite.line ||
    cmp(a.advisory.id, b.advisory.id)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
