import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// The GraphQL document a call sends, recorded as the request body's `query` so advisories can match on what it selects.
const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-graphql-"));
const files: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { "@shopify/admin-api-client": "^1.0.0", "graphql-tag": "^2.12.0" } }),
  "src/fetch.ts": `export async function discounts(token: string) {
  return fetch("https://acme.myshopify.com/admin/api/2026-10/graphql.json", {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: "query { automaticDiscounts(first: 10) { nodes { id } } }" }),
  });
}
`,
  "src/client.ts": `import { createAdminApiClient } from "@shopify/admin-api-client";
import gql from "graphql-tag";
const client = createAdminApiClient({ storeDomain: "acme.myshopify.com", apiVersion: "2026-10", accessToken: "x" });
const UPDATE = \`#graphql
  mutation Update($input: MarketCurrencySettingsUpdateInput!) { marketCurrencySettingsUpdate(input: $input) { userErrors { field } } }\`;
const SHOP = gql\`query { shop { name } }\`;
export async function run(input: unknown, query: string) {
  await client.request(UPDATE, { variables: { input } });
  await client.request(SHOP);
  await client.request(query);
}
`,
  "app/routes/app._index.tsx": `import { authenticate } from "../shopify.server";
export async function loader({ request }: { request: Request }) {
  const { admin } = await authenticate.admin(request);
  return admin.graphql(\`#graphql
    query { automaticDiscounts(first: 5) { nodes { id } } }\`);
}
`,
  "src/other.ts": `export async function notShopify(api: { graphql: (q: string) => Promise<unknown> }) {
  return api.graphql("query { viewer { login } }");
}
`,
};

let sites: CallSite[] = [];
beforeAll(() => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  sites = extractCallSites(dir).callSites;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const query = (s: CallSite | undefined) => s?.surface.body?.find((b) => b.name === "query")?.value;

describe("GraphQL documents", () => {
  it("a fetch to a GraphQL endpoint already sends its document as the body's query", () => {
    expect(query(sites.find((s) => s.file === "src/fetch.ts"))).toBe("query { automaticDiscounts(first: 10) { nodes { id } } }");
  });

  it("an SDK GraphQL client's first argument is its document: a template const, a gql tag, or unknown", () => {
    const calls = sites.filter((s) => s.file === "src/client.ts").sort((a, b) => a.line - b.line);
    expect(calls.map((s) => s.endpoint)).toEqual(["/admin/api/{version}/graphql.json", "/admin/api/{version}/graphql.json", "/admin/api/{version}/graphql.json"]);
    expect(query(calls[0])).toContain("marketCurrencySettingsUpdate(input: $input)");
    expect(query(calls[1])).toBe("query { shop { name } }");
    // A document passed in a parameter isn't known: the matcher treats the call as one it cannot read.
    expect(calls[2]!.surface.body).toBeUndefined();
  });

  it("finds a Shopify app template's admin.graphql(document), and not another .graphql() in a file that doesn't import Shopify", () => {
    const remix = sites.find((s) => s.file === "app/routes/app._index.tsx");
    expect(remix).toMatchObject({ provider: "shopify", kind: "sdk", client: "admin.graphql", method: "POST", endpoint: "/admin/api/{version}/graphql.json", resolved: true });
    expect(query(remix)).toContain("automaticDiscounts(first: 5)");
    expect(sites.some((s) => s.file === "src/other.ts")).toBe(false);
  });
});
