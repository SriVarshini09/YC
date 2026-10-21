import { z } from "zod";
import rawProviders from "../providers.json";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** "METHOD /path/{param}" as written in provider docs. */
const EndpointRefSchema = z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/);

export const ProviderSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** Exact hostnames, or "*.example.com" for any subdomain of example.com. */
  hosts: z.array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/)).min(1),
  /** npm packages that are this provider's SDKs. */
  sdkPackages: z.array(z.string().min(1)),
  /** SDK method chain (after the client, without a leading "rest.") to the HTTP endpoint it calls. */
  sdkMethods: z.record(z.string(), EndpointRefSchema).optional(),
  docsUrl: z.url(),
  changelogUrl: z.url().optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderRegistrySchema = z
  .array(ProviderSchema)
  .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "provider ids must be unique");

let cached: Provider[] | undefined;

export function loadProviders(): Provider[] {
  cached ??= ProviderRegistrySchema.parse(rawProviders);
  return cached;
}

export function getProvider(id: string): Provider | undefined {
  return loadProviders().find((p) => p.id === id);
}

/**
 * Resolve a hostname to a provider. Exact host entries win over wildcards,
 * and longer wildcards win over shorter ones ("generativelanguage.googleapis.com"
 * beats "*.googleapis.com").
 */
export function providerForHost(host: string): Provider | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  let best: { provider: Provider; score: number } | undefined;
  for (const provider of loadProviders()) {
    for (const pattern of provider.hosts) {
      let score = -1;
      if (pattern === h) score = 10_000;
      else if (pattern.startsWith("*.") && h.endsWith(pattern.slice(1))) score = pattern.length;
      if (score > (best?.score ?? -1)) best = { provider, score };
    }
  }
  return best?.provider;
}

export function providerForPackage(name: string): Provider | undefined {
  return loadProviders().find((p) => p.sdkPackages.includes(name));
}

/** Map an SDK method chain like "rest.actions.createWorkflowDispatch" to "POST /repos/...". */
export function sdkEndpoint(provider: Provider, chain: string): { method: HttpMethod; path: string } | undefined {
  const methods = provider.sdkMethods ?? {};
  const key = chain.replace(/^rest\./, "");
  const ref = methods[key];
  if (!ref) return undefined;
  const [method, path] = ref.split(" ") as [HttpMethod, string];
  return { method, path };
}
