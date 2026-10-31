import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// A request inside a wrapper, its base URL from helpers in another file: the shape of a real breakage SHAPI
// 0.3.4 missed on APIBreak-Replay (mindstone/mcp-servers).
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));

function scan(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-wrap-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    const r = extractCallSites(dir);
    return { ...r, match: matchAdvisories(createApiLock(r, "t"), advisories, { now: new Date("2026-10-31T12:00:00Z") }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const sites = (r: ReturnType<typeof scan>) => r.callSites.filter((s) => s.provider === "quickbooks").map((s) => `${s.file}:${s.line} ${s.endpoint} ${JSON.stringify(s.surface.query)}`);

const auth = `let environment = process.env.QB_ENV ?? "production";
let realmId = "";
export function getApiHost(): string {
  return environment === "sandbox" ? "sandbox-quickbooks.api.intuit.com" : "quickbooks.api.intuit.com";
}
export function getBaseUrl(): string {
  return \`https://\${getApiHost()}/v3/company/\${realmId}\`;
}
`;
const client = `import { getBaseUrl } from "./auth.js";
export async function qboFetch<T>(entityPath: string, options: RequestInit = {}, retryCount = 0): Promise<T> {
  const url = \`\${getBaseUrl()}\${entityPath}\`;
  const response = await fetch(url, { ...options, headers: { Accept: "application/json" } });
  if (response.status === 429 && retryCount < 3) return qboFetch(entityPath, options, retryCount + 1);
  return (await response.json()) as T;
}
export const qboQuery = (q: string) => qboFetch(\`/query?query=\${encodeURIComponent(q)}&minorversion=75\`);
`;
const bills = (minor: string) => `import { qboFetch } from "../client.js";
export async function createBill(body: object) {
  return qboFetch("/bill?minorversion=${minor}", { method: "POST", body: JSON.stringify(body) });
}
`;

describe("requests inside wrappers (TypeScript)", () => {
  it("reads a wrapper once per caller across files, with a base URL from imported helpers", () => {
    const r = scan({ "src/auth.ts": auth, "src/client.ts": client, "src/tools/bills.ts": bills("65") });
    expect(sites(r)).toEqual([
      // the base URL string itself, as before
      "src/auth.ts:7 /v3/company/{realmId} []",
      'src/client.ts:4 /v3/company/{realmId}/query [{"name":"query","value":"{q}"},{"name":"minorversion","value":"75"}]',
      'src/client.ts:4 /v3/company/{realmId}/bill [{"name":"minorversion","value":"65"}]',
    ]);
    expect(r.match.affected.map((f) => `${f.advisory.id} ${f.callSite.endpoint}`)).toEqual(["quickbooks-minorversion-below-75-ignored /v3/company/{realmId}/bill"]);
  });

  it("is not affected once every caller sends a current minorversion", () => {
    const r = scan({ "src/auth.ts": auth, "src/client.ts": client, "src/tools/bills.ts": bills("75") });
    expect(r.match.affected).toEqual([]);
  });

  it("leaves a wrapper as it is when nothing calls it", () => {
    const r = scan({ "src/auth.ts": auth, "src/client.ts": client.replace(/export const qboQuery.*\n/, "") });
    expect(r.callSites.filter((s) => s.file === "src/client.ts").map((s) => s.endpoint)).toEqual(["/v3/company/{realmId}{entityPath}"]);
  });

  it("does not take a caller in another file that does not import the wrapper", () => {
    const r = scan({ "src/auth.ts": auth, "src/client.ts": client, "src/other.ts": 'function qboFetch(p: string) { return p; }\nqboFetch("/bill?minorversion=65");\n' });
    expect(r.match.affected).toEqual([]);
  });
});
