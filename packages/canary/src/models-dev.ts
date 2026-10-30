import { providerForHost, type Advisory, type HttpMethod } from "@shapi/core";

/**
 * models.dev ingest (execution plan C-04): every model models.dev marks `status: "deprecated"` on a host SHAPI knows
 * becomes an unverified `version-sunset` draft that flags code sending that model. models.dev gives no shutdown date,
 * so a draft takes the day it was first seen; a person adds the date and the replacement when verifying it.
 */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** The part of models.dev's api.json the ingest reads. */
export interface ModelsDevApi {
  [provider: string]: {
    id?: string;
    name?: string;
    /** Base URL, for providers reached through an OpenAI-compatible SDK. */
    api?: string;
    /** The AI SDK package, for providers with their own (their host is the SDK's default). */
    npm?: string;
    doc?: string;
    models?: Record<string, { id?: string; name?: string; status?: string }>;
  };
}

/** The host each first-party AI SDK package calls by default. */
const SDK_HOSTS: Record<string, string> = {
  "@ai-sdk/openai": "api.openai.com",
  "@ai-sdk/anthropic": "api.anthropic.com",
  "@ai-sdk/google": "generativelanguage.googleapis.com",
};

/** Where a provider takes the model: the request body's `model` on each endpoint that does. */
const MODEL_ENDPOINTS: Record<string, { method: HttpMethod; path: string }> = {
  openai: { method: "POST", path: "/v1/**" },
  anthropic: { method: "POST", path: "/v1/messages" },
  // Gemini names the model in the path (models/gemini-2.0-flash:generateContent); SDK calls pass it as `model`.
  "google-gemini": { method: "POST", path: "/*/models/{?}:*" },
};

export interface ModelsDevDraft {
  provider: string;
  model: string;
  advisory: Advisory;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The host a models.dev provider is reached at, if SHAPI can tell. */
export function modelsDevHost(entry: ModelsDevApi[string]): string | undefined {
  if (entry.api) {
    try {
      return new URL(entry.api).hostname;
    } catch {
      return undefined;
    }
  }
  return entry.npm ? SDK_HOSTS[entry.npm] : undefined;
}

/** One draft per deprecated model on a host in providers.json, sorted by provider and model. */
export function modelsDevDrafts(api: ModelsDevApi, opts: { today: string }): ModelsDevDraft[] {
  const out: ModelsDevDraft[] = [];
  for (const [key, entry] of Object.entries(api)) {
    const host = modelsDevHost(entry);
    const provider = host ? providerForHost(host) : undefined;
    if (!provider) continue;
    for (const [modelKey, model] of Object.entries(entry.models ?? {})) {
      if (model.status !== "deprecated") continue;
      const id = model.id ?? modelKey;
      const values = provider.id === "google-gemini" ? [id, `models/${id}`] : [id];
      const label = model.name && model.name !== id ? `${model.name} (\`${id}\`)` : `\`${id}\``;
      out.push({
        provider: provider.id,
        model: id,
        advisory: {
          id: `${provider.id}-${slugify(id)}-deprecated`,
          provider: provider.id,
          title: `${provider.name} deprecated ${id}`,
          summary: `models.dev lists ${label} as deprecated on ${entry.name ?? key}. Calls that send this model will fail once ${provider.name} removes it. Unverified: drafted from models.dev, not yet checked against ${provider.name}'s deprecation notice.`,
          endpoint: MODEL_ENDPOINTS[provider.id] ?? { method: "POST", path: "/**" },
          changeClass: "version-sunset",
          trigger: { body: [{ field: "model", values }] },
          firstObserved: opts.today,
          publishedNotice: null,
          effectiveDate: opts.today,
          severity: "medium",
          migrationNote: `Move off ${id} before ${provider.name} removes it. Check ${provider.name}'s deprecation notice for the shutdown date and the recommended replacement.`,
          sources: [MODELS_DEV_URL, ...(entry.doc ? [entry.doc] : [])],
          status: "unverified",
        },
      });
    }
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
