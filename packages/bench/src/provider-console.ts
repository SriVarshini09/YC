import type { ApiLock, CallSite } from "@shapi/core";

/**
 * Provider console v0 (execution plan PC-01): what a provider's API consumers depend on, from many repositories'
 * api.locks, as counts of repositories: "N repositories call endpoint X; M of them read field Y". A count below
 * `k` repositories is never shown, and a provider used by fewer than `k` is left out, so no repository can be
 * picked out. The report names no repository, file or value; only endpoints and the names of what code reads and sends.
 */
export const CONSOLE_K = 5;

export interface Count {
  name: string;
  repos: number;
}

export interface ConsoleEndpoint {
  /** `POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`. */
  operation: string;
  repos: number;
  /** Response fields read. */
  fields: Count[];
  /** Status codes compared against. */
  statusCodes: Count[];
  /** Request headers set (version pins live here). */
  headers: Count[];
  /** Query parameters sent. */
  query: Count[];
}

export interface ProviderReport {
  provider: string;
  repos: number;
  endpoints: ConsoleEndpoint[];
  /** Endpoints called by fewer than k repositories, which are not listed. */
  endpointsBelowK: number;
}

export interface ProviderConsole {
  k: number;
  /** Repositories in the corpus. */
  repos: number;
  providers: ProviderReport[];
  /** Providers used by fewer than k repositories, which are left out. */
  providersBelowK: number;
}

/** Repositories per name, from one set of names per repository; only counts of at least k, most first. */
function counted(perRepo: Set<string>[], k: number): Count[] {
  const n = new Map<string, number>();
  for (const names of perRepo) for (const name of names) n.set(name, (n.get(name) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= k).map(([name, repos]) => ({ name, repos })).sort((a, b) => b.repos - a.repos || a.name.localeCompare(b.name));
}

/**
 * The endpoint a call site makes, or undefined when SHAPI could not tell it: no method (a bare URL constant), or a path
 * with no literal segment (`/{}`, a URL built from a variable). Placeholders take the name of the code's variable
 * (`{owner}`, `{o}`), so they are all written `{}`: one endpoint is one shape.
 */
const operationOf = (s: CallSite) => {
  if (!s.resolved || !s.method || !s.endpoint) return undefined;
  const path = s.endpoint.replace(/\{[^}]*\}/g, "{}");
  return /\/[^/{]/.test(path) ? `${s.method} ${path}` : undefined;
};

export function providerConsole(locks: ApiLock[], k = CONSOLE_K): ProviderConsole {
  const providers = new Set(locks.flatMap((l) => l.callSites.flatMap((s) => (s.provider ? [s.provider] : []))));
  const reports: ProviderReport[] = [];
  let providersBelowK = 0;
  for (const provider of [...providers].sort()) {
    // Each repository's call sites for this provider, by operation.
    const repos = locks.map((l) => l.callSites.filter((s) => s.provider === provider)).filter((sites) => sites.length);
    if (repos.length < k) {
      providersBelowK++;
      continue;
    }
    const operations = new Map<string, CallSite[][]>();
    for (const sites of repos) {
      const byOp = new Map<string, CallSite[]>();
      for (const s of sites) {
        const op = operationOf(s);
        if (op) byOp.set(op, [...(byOp.get(op) ?? []), s]);
      }
      for (const [op, ss] of byOp) operations.set(op, [...(operations.get(op) ?? []), ss]);
    }
    const endpoints: ConsoleEndpoint[] = [];
    let endpointsBelowK = 0;
    for (const [operation, perRepo] of operations) {
      if (perRepo.length < k) {
        endpointsBelowK++;
        continue;
      }
      const names = (pick: (s: CallSite) => string[]) => counted(perRepo.map((ss) => new Set(ss.flatMap(pick))), k);
      endpoints.push({
        operation,
        repos: perRepo.length,
        fields: names((s) => s.surface.fields),
        statusCodes: names((s) => s.surface.statusCodes.map(String)),
        headers: names((s) => s.surface.headers.map((h) => h.name)),
        query: names((s) => s.surface.query.map((q) => q.name)),
      });
    }
    endpoints.sort((a, b) => b.repos - a.repos || a.operation.localeCompare(b.operation));
    reports.push({ provider, repos: repos.length, endpoints, endpointsBelowK });
  }
  return { k, repos: locks.length, providers: reports.sort((a, b) => b.repos - a.repos || a.provider.localeCompare(b.provider)), providersBelowK };
}
