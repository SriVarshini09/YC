import type { HttpMethod } from "@shapi/core";

export type Env = Record<string, string | undefined>;

/** One request a canary makes on a schedule. */
export interface Probe {
  /** Stable id, for example "github:get-repo". */
  id: string;
  provider: string;
  method: HttpMethod;
  /** Endpoint pattern as in provider docs; shapes are stored under it. */
  endpoint: string;
  /** Concrete URL requested. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Whether the request carries credentials. Providers answer the same endpoint
   * differently for signed-in callers (GitHub adds `permissions`, drops
   * `temp_clone_token`), so each mode keeps its own history.
   */
  auth: "anonymous" | "token";
}

/** Store source for a probe's observations: one history per provider and auth mode. */
export function probeSource(probe: Pick<Probe, "provider" | "auth">): string {
  return `canary:${probe.provider}:${probe.auth}`;
}

/** A provider's canary: builds its probes from the environment (credentials, test resources). */
export interface Worker {
  provider: string;
  /** Probes that can run with this environment, plus why the others were skipped. */
  probes(env: Env): { probes: Probe[]; skipped: { id: string; reason: string }[] };
}
