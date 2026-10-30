import { describe, expect, it } from "vitest";
import { createApiLock, type ApiLock, type CallSite, type Surface } from "@shapi/core";
import { providerConsole } from "@shapi/bench";

// Execution plan PC-01: per-provider aggregates with a k≥5 repository threshold; nothing identifies a repository.
const empty: Surface = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
const site = (provider: string, endpoint: string | null, surface: Partial<Surface> = {}, file = "src/a.ts"): CallSite => ({
  file,
  line: 1,
  column: 1,
  provider,
  kind: "http",
  client: "fetch",
  method: "GET",
  host: null,
  endpoint,
  resolved: endpoint !== null,
  surface: { ...empty, ...surface },
});
const lock = (...sites: CallSite[]): ApiLock => createApiLock({ callSites: sites, declared: [] }, "t");

describe("providerConsole", () => {
  // Six repositories call /user and read login; five also send a version header; one reads a private field.
  const locks = [
    ...Array.from({ length: 5 }, (_, i) =>
      lock(site("github", "/user", { fields: ["login"], headers: [{ name: "x-github-api-version", value: "2022-11-28" }] }, `src/r${i}.ts`), site("github", "/user", { fields: ["login", "id"] }, "src/b.ts")),
    ),
    lock(site("github", "/user", { fields: ["login", "secret_field_only_here"], statusCodes: [404] }, "src/acme-internal.ts"), site("github", "/orgs/{org}/repos"), site("github", null)),
    // Stripe: three repositories only.
    ...Array.from({ length: 3 }, () => lock(site("stripe", "/v1/charges", { fields: ["amount"] }))),
  ];
  const report = providerConsole(locks, 5);

  it("counts repositories, not call sites, and lists only counts of at least k", () => {
    expect(report.repos).toBe(9);
    expect(report.providers.map((p) => `${p.provider} ${p.repos}`)).toEqual(["github 6"]);
    expect(report.providersBelowK).toBe(1);
    const github = report.providers[0]!;
    expect(github.endpoints).toEqual([
      { operation: "GET /user", repos: 6, fields: [{ name: "login", repos: 6 }, { name: "id", repos: 5 }], statusCodes: [], headers: [{ name: "x-github-api-version", repos: 5 }], query: [] },
    ]);
    // /orgs/{org}/repos has one repository: not listed, only counted.
    expect(github.endpointsBelowK).toBe(1);
  });

  it("leaves out calls whose endpoint SHAPI could not tell: a URL from a variable, or a URL with no method", () => {
    const vague = Array.from({ length: 6 }, (_, i) => lock(site("github", "/{url}", {}, `src/v${i}.ts`), { ...site("github", "/user"), method: null }));
    expect(providerConsole(vague, 5).providers[0]).toMatchObject({ provider: "github", repos: 6, endpoints: [], endpointsBelowK: 0 });
  });

  it("names no repository, file, header value or field fewer than k repositories read", () => {
    const text = JSON.stringify(report);
    for (const s of ["src/", "acme-internal", "2022-11-28", "secret_field_only_here", "404", "stripe"]) expect(text).not.toContain(s);
  });
});
