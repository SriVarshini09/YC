import { createHash } from "node:crypto";
import { getProvider } from "./providers";
import type { ApiLock, LockedCallSite } from "./lockfile";

/**
 * api.lock as a CycloneDX 1.7 SaaSBOM (execution plan S-02): the third-party APIs a repository calls, in the format
 * security and procurement tools already read.
 * - Each provider is a `service`, with the endpoints the code calls.
 * - Each client the code calls it through (an SDK package, `fetch`, `axios`) is a `library` component whose
 *   `evidence.occurrences` are the call sites: file, line, column and the operation.
 * - SHAPI's own data sits in properties under the `shapi:` namespace.
 * The output depends only on the lock and the names passed in, so the same lock gives the same bytes.
 */
export const CYCLONEDX_SPEC_VERSION = "1.7";

export interface SbomOptions {
  /** The repository, `owner/name`. */
  name: string;
  /** The commit the lock was built from. */
  sha?: string;
  /** SHAPI's version, for `metadata.tools`. */
  toolVersion?: string;
}

const ref = (...parts: string[]) => parts.map((p) => p.replace(/[^A-Za-z0-9@._/-]+/g, "-")).join(":");

/** `{owner}` is not legal in an IRI: templated segments are percent-encoded, and the template is kept in a property. */
const iri = (host: string, endpoint: string) => `https://${host}${endpoint.replace(/[{}]/g, (c) => (c === "{" ? "%7B" : "%7D")).replace(/ /g, "%20")}`;

/** A UUID derived from the content, so a re-export of the same lock keeps its serial number. */
function contentUuid(text: string): string {
  const h = createHash("sha256").update(text).digest("hex").slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const prop = (name: string, value: string | number | boolean) => ({ name: `shapi:${name}`, value: String(value) });

export function apiLockToCycloneDx(lock: ApiLock, opts: SbomOptions): Record<string, unknown> {
  const root = ref("repo", opts.name);
  const known = lock.callSites.filter((s): s is LockedCallSite & { provider: string } => s.provider !== null);
  const byProvider = new Map<string, (LockedCallSite & { provider: string })[]>();
  for (const s of known) byProvider.set(s.provider, [...(byProvider.get(s.provider) ?? []), s]);
  const providers = [...byProvider.keys()].sort();

  const services = providers.map((id) => {
    const sites = byProvider.get(id)!;
    const ops = [...new Set(sites.filter((s) => s.method && s.endpoint).map((s) => `${s.method} ${s.endpoint}`))].sort();
    const endpoints = [...new Set(sites.filter((s) => s.host && s.endpoint).map((s) => iri(s.host!, s.endpoint!)))].sort();
    const provider = getProvider(id);
    return {
      "bom-ref": ref("service", id),
      provider: { name: provider?.name ?? id, ...(provider?.docsUrl ? { url: [provider.docsUrl] } : {}) },
      name: provider?.name ?? id,
      ...(endpoints.length ? { endpoints } : {}),
      properties: [prop("provider", id), prop("callSites", sites.length), ...ops.map((op) => prop("operation", op))],
    };
  });

  const clients = new Map<string, (LockedCallSite & { provider: string })[]>();
  for (const s of known) {
    const key = `${s.provider}\u0000${s.client}`;
    clients.set(key, [...(clients.get(key) ?? []), s]);
  }
  const components = [...clients.keys()].sort().map((key) => {
    const [provider, client] = key.split("\u0000") as [string, string];
    const sites = clients.get(key)!;
    return {
      type: "library",
      "bom-ref": ref("client", provider, client),
      name: client,
      properties: [prop("provider", provider), prop("kind", sites[0]!.kind), prop("callSites", sites.length)],
      evidence: {
        occurrences: sites.map((s) => ({
          "bom-ref": ref("callsite", s.id),
          location: s.file,
          line: s.line,
          offset: s.column,
          ...(s.method || s.endpoint ? { symbol: `${s.method ?? "?"} ${s.endpoint ?? "?"}` } : {}),
          additionalContext: `shapi:callSite=${s.id}; resolved=${s.resolved}`,
        })),
      },
    };
  });

  const serial = contentUuid(`${opts.name}\n${opts.sha ?? ""}\n${JSON.stringify(lock)}`);
  return {
    bomFormat: "CycloneDX",
    specVersion: CYCLONEDX_SPEC_VERSION,
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      tools: { components: [{ type: "application", name: "shapi", ...(opts.toolVersion ? { version: opts.toolVersion } : {}), externalReferences: [{ type: "website", url: "https://shapi.dev" }] }] },
      component: { type: "application", "bom-ref": root, name: opts.name, ...(opts.sha ? { version: opts.sha } : {}) },
      properties: [prop("lockfileVersion", lock.lockfileVersion), prop("generator", lock.generator), prop("callSites", lock.callSites.length), prop("unresolvedCallSites", lock.callSites.length - known.length)],
    },
    components,
    services,
    dependencies: [
      { ref: root, dependsOn: components.map((c) => c["bom-ref"]) },
      ...components.map((c) => ({ ref: c["bom-ref"], dependsOn: [ref("service", c.properties[0]!.value)] })),
      ...services.map((s) => ({ ref: s["bom-ref"] })),
    ],
  };
}
