/**
 * Spec-history replay for GitHub (execution plan P-09). github/rest-api-description publishes one description per
 * REST API version side by side, so the replay diffs `2022-11-28` against `2026-03-10` at one commit and scores the
 * changes against GitHub's breaking-changes page for the new version.
 */
import type { SpecChange } from "./spec-replay";

/** One breaking change GitHub lists for an API version: its title, the endpoints it names, and the names in its title. */
export interface GithubBreakingEntry {
  title: string;
  /** `GET /rate_limit`, as in the entry's "Affected endpoints". */
  endpoints: string[];
  /** Field, value and status-code names the title quotes (`rate`, `"assignee"`, `204`). */
  names: string[];
}

/** The entries of one `## Version <date>` section of docs.github.com's breaking-changes page (its markdown body). */
export function parseGithubBreakingChanges(markdown: string, version: string): GithubBreakingEntry[] {
  const section = new RegExp(`^## Version ${version.replace(/-/g, "\\-")}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(markdown)?.[1] ?? "";
  const out: GithubBreakingEntry[] = [];
  // Each entry starts with a bold bullet at the left margin; its title can wrap onto the next lines.
  for (const block of section.split(/^\* \*\*/m).slice(1)) {
    const title = block.slice(0, block.indexOf("**")).replace(/\s+/g, " ").trim();
    const endpoints = [...block.matchAll(/^\s*\* `((?:GET|POST|PUT|PATCH|DELETE) [^`]+)`/gm)].map((m) => m[1]!);
    const names = [...title.matchAll(/`([^`]+)`|"([^"]+)"/g)].map((m) => (m[1] ?? m[2])!).filter((n) => !/^(GET|POST|PUT|PATCH|DELETE) /.test(n));
    out.push({ title, endpoints, names });
  }
  return out;
}

/**
 * A spec change matches an entry when it is on one of the entry's endpoints (directly, or in a schema those endpoints
 * return) and, when the title names fields, values or status codes, on one of them.
 */
export function changeMatchesGithubEntry(c: SpecChange, e: GithubBreakingEntry, returning: Map<string, string[]>): boolean {
  const onEndpoint = c.operation ? e.endpoints.includes(c.operation) : Boolean(c.schema && (returning.get(c.schema) ?? []).some((op) => e.endpoints.includes(op)));
  if (!onEndpoint) return false;
  if (!e.names.length) return true;
  const leaf = c.field?.split(".").pop();
  return e.names.some((n) => n === c.field || n === leaf || (c.values ?? []).includes(n));
}

export interface GithubReplayScore {
  version: string;
  previous: string;
  commit: string;
  candidates: number;
  candidatesByKind: Record<string, number>;
  breakingEntries: number;
  /** Entries a spec change matches. */
  found: number;
  /** Entries no field, value or status change can show (a media type, a validation rule, a header). */
  behaviorOnly: number;
  missed: { title: string; reason: string }[];
  /** Spec changes that match a listed breaking change, and those that match none. */
  candidatesMatching: number;
  candidatesUnlisted: number;
  /** What `GET https://api.github.com/versions` answered when the replay ran. */
  supportedVersions: string[];
}

/** Titles that describe a change no response or request schema shows. */
const BEHAVIOR = /content-type|media type|validation|only accept/i;

export function scoreGithubReplay(input: {
  version: string;
  previous: string;
  commit: string;
  changes: SpecChange[];
  entries: GithubBreakingEntry[];
  returning: Map<string, string[]>;
  supportedVersions: string[];
}): GithubReplayScore {
  const { changes, entries, returning } = input;
  const matches = (c: SpecChange, e: GithubBreakingEntry) => changeMatchesGithubEntry(c, e, returning);
  const missed: GithubReplayScore["missed"] = [];
  let found = 0;
  let behaviorOnly = 0;
  for (const e of entries) {
    if (changes.some((c) => matches(c, e))) found++;
    else if (BEHAVIOR.test(e.title)) {
      behaviorOnly++;
      missed.push({ title: e.title, reason: "a behavior change: no field, value or status code in the spec shows it" });
    } else missed.push({ title: e.title, reason: `no spec change on ${e.endpoints.slice(0, 2).join(", ") || "its endpoints"} matches ${e.names.join(", ") || "it"}` });
  }
  const candidatesByKind: Record<string, number> = {};
  for (const c of changes) candidatesByKind[c.kind] = (candidatesByKind[c.kind] ?? 0) + 1;
  const candidatesMatching = changes.filter((c) => entries.some((e) => matches(c, e))).length;
  return {
    version: input.version,
    previous: input.previous,
    commit: input.commit,
    candidates: changes.length,
    candidatesByKind,
    breakingEntries: entries.length,
    found,
    behaviorOnly,
    missed,
    candidatesMatching,
    candidatesUnlisted: changes.length - candidatesMatching,
    supportedVersions: input.supportedVersions,
  };
}
