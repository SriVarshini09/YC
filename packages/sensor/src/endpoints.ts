import ENDPOINTS from "./endpoints.json" with { type: "json" };

/** An endpoint the sensor records: its provider, the hosts it is served from, and its path pattern. */
export interface SensorEndpoint {
  provider: string;
  method: string;
  /** The advisory's path pattern: what the sensor reports instead of the request's own path. */
  path: string;
  hosts: string[];
  /** The pattern as a regular expression over concrete paths (the same in Node and Python). */
  re: string;
}

export const SENSOR_ENDPOINTS = ENDPOINTS as SensorEndpoint[];

/**
 * A path pattern as a regular expression over concrete request paths: `{name}` and `{?}` are one segment, `*` is
 * within a segment, `**` any number of segments. Only syntax Python's `re` reads the same way.
 */
export function patternRegex(pattern: string): string {
  let re = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("/**", i)) {
      re += "(?:/.*)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (pattern[i] === "{") {
      const end = pattern.indexOf("}", i);
      re += "[^/]+";
      i = end < 0 ? pattern.length : end + 1;
    } else {
      re += pattern[i]!.replace(/[.+?^$()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return `^${re}/?$`;
}

const hostMatches = (host: string, pattern: string) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern);

/**
 * The endpoint a request belongs to, or undefined: the host must be the provider's and the path must match a
 * pattern. When several match, the most specific one (the longest pattern without wildcards) wins.
 */
export function matchEndpoint(method: string, url: URL, endpoints: SensorEndpoint[] = SENSOR_ENDPOINTS): SensorEndpoint | undefined {
  const m = method.toUpperCase();
  let best: SensorEndpoint | undefined;
  for (const e of endpoints) {
    if (e.method !== "*" && e.method !== m) continue;
    if (!e.hosts.some((h) => hostMatches(url.hostname, h))) continue;
    if (!new RegExp(e.re).test(url.pathname)) continue;
    if (!best || e.path.replace(/\*|\{[^}]*\}/g, "").length > best.path.replace(/\*|\{[^}]*\}/g, "").length) best = e;
  }
  return best;
}
