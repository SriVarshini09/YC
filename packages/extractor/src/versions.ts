import type { CallSite } from "@shapi/core";

// API version pins kept apart from the URL: `GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")` in settings,
// `META_GRAPH_VERSION: z.string().default("v21.0")`, `WHATSAPP_API_VERSION=v21.0` in .env.example, while the request is
// built elsewhere as `https://graph.facebook.com/${GRAPH_API_VERSION}/…`. The call site's path then holds
// `{GRAPH_API_VERSION}`, which no version-sunset advisory can match. Most of SHAPI's misses on APIBreak-Replay v1's
// Meta Graph cases look like this.

const VERSION = String.raw`v\d+(?:\.\d+)?`;
/** A name that says it holds a version: GRAPH_API_VERSION, graphApiVersion, apiVer. */
const VERSIONISH = /version|ver$|apiver/i;
const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Every version literal assigned to a version-named key, by normalized name. Sources and .env files alike. */
export function versionPins(files: { path: string; text: string }[]): Map<string, Set<string>> {
  const pins = new Map<string, Set<string>>();
  const add = (name: string, value: string) => {
    if (!VERSIONISH.test(name)) return;
    const key = norm(name);
    const set = pins.get(key) ?? new Set<string>();
    set.add(value);
    pins.set(key, set);
  };
  const assign = new RegExp(String.raw`(?:^|[\s,{(])["']?([A-Za-z_][\w]*)["']?\s*(?::(?!:)|=(?!=))[^\n]*?["'\`](${VERSION})["'\`]`, "g");
  const env = new RegExp(String.raw`(?:getenv|environ\.get|environ\[|process\.env\.|Deno\.env\.get)\(?\s*["']?([A-Za-z_][\w]*)["']?[^\n]*?["'\`](${VERSION})["'\`]`, "g");
  const dotenv = new RegExp(String.raw`^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*["']?(${VERSION})["']?\s*(?:#.*)?$`);
  for (const f of files) {
    const isEnv = /(^|\/)\.env(\.[\w.-]+)?$/.test(f.path);
    for (const line of f.text.split(/\r?\n/)) {
      if (isEnv) {
        const m = dotenv.exec(line);
        if (m) add(m[1]!, m[2]!);
        continue;
      }
      for (const m of line.matchAll(assign)) add(m[1]!, m[2]!);
      for (const m of line.matchAll(env)) add(m[1]!, m[2]!);
    }
  }
  return pins;
}

/**
 * Fill a call site's `{…version…}` path segment from the repository's pins, when the name has exactly one pinned
 * value (`{GRAPH_API_VERSION}` → `v21.0`). Several values, or none, leave the segment as it is.
 */
export function applyVersionPins(sites: CallSite[], pins: Map<string, Set<string>>): void {
  for (const site of sites) {
    if (!site.endpoint || !site.endpoint.includes("{")) continue;
    const segments = site.endpoint.split("/").map((seg) => {
      const m = /^\{([^}]+)\}$/.exec(seg);
      if (!m || !VERSIONISH.test(m[1]!)) return seg;
      const values = pins.get(norm(m[1]!));
      return values && values.size === 1 ? [...values][0]! : seg;
    });
    site.endpoint = segments.join("/");
  }
}
