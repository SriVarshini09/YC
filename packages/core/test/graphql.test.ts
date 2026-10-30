import { describe, expect, it } from "vitest";
import { createApiLock, graphqlPathsFor, graphqlSelections, matchAdvisories, type Advisory, type CallSite, type Surface } from "@shapi/core";

describe("graphqlSelections", () => {
  it("reads operations and every selected field as a dotted path, past arguments, variables, directives and aliases", () => {
    const doc = `#graphql
      query Discounts($first: Int!, $q: String = "a { b }") {
        list: automaticDiscounts(first: $first, query: $q) @include(if: true) {
          nodes { id title }
        }
        shop { name }
      }`;
    expect(graphqlSelections(doc)).toEqual({
      operations: ["query"],
      paths: ["automaticDiscounts", "automaticDiscounts.nodes", "automaticDiscounts.nodes.id", "automaticDiscounts.nodes.title", "shop", "shop.name"],
    });
  });

  it("handles mutations, the shorthand query, inline fragments and named fragments", () => {
    expect(graphqlSelections(`{ shop { id } }`)).toEqual({ operations: ["query"], paths: ["shop", "shop.id"] });
    const doc = `
      mutation Update($input: In!) { marketCurrencySettingsUpdate(input: $input) { userErrors { ...Err } } }
      query { node(id: "x") { ... on DraftOrder { warnings { ... on DraftOrderDiscountNotAppliedWarning { priceRule { id } } } } } }
      fragment Err on UserError { field message }`;
    const s = graphqlSelections(doc)!;
    expect(s.operations).toEqual(["mutation", "query"]);
    expect(s.paths).toEqual(
      expect.arrayContaining(["marketCurrencySettingsUpdate.userErrors.field", "marketCurrencySettingsUpdate.userErrors.message", "node.warnings.priceRule", "node.warnings.priceRule.id"]),
    );
  });

  it("gives undefined for text it cannot follow, such as a document with an interpolated piece", () => {
    expect(graphqlSelections("query { shop { {FIELDS} } }")).toBeUndefined();
    expect(graphqlSelections("query { shop { name }")).toBeUndefined();
    expect(graphqlSelections("not graphql")).toBeUndefined();
  });

  it("matches a trigger field as a root field, a path, or a name at any depth", () => {
    const s = graphqlSelections("query { node(id: 1) { ... on DraftOrder { warnings { priceRule { id } } } } automaticDiscounts { nodes { id } } }")!;
    expect(graphqlPathsFor(s, "automaticDiscounts")).toEqual(["automaticDiscounts", "automaticDiscounts.nodes", "automaticDiscounts.nodes.id"]);
    expect(graphqlPathsFor(s, "priceRule")).toEqual(["node.warnings.priceRule"]);
    expect(graphqlPathsFor(s, "node.warnings")).toEqual(["node.warnings", "node.warnings.priceRule", "node.warnings.priceRule.id"]);
    expect(graphqlPathsFor(s, "discount")).toEqual([]);
  });
});

describe("the graphql trigger", () => {
  const empty: Surface = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
  let line = 0;
  const site = (query: string | null | undefined): CallSite => ({
    file: "src/app.ts",
    line: ++line,
    column: 1,
    provider: "shopify",
    kind: "sdk",
    client: "@shopify/admin-api-client",
    method: "POST",
    host: null,
    endpoint: "/admin/api/{version}/graphql.json",
    resolved: true,
    surface: { ...empty, ...(query === undefined ? {} : { body: [{ name: "query", value: query }] }) },
  });
  const advisory = (trigger: Advisory["trigger"]): Advisory => ({
    id: "shopify-x",
    provider: "shopify",
    title: "t",
    summary: "s",
    endpoint: { method: "POST", path: "/admin/api/{version}/graphql.json" },
    changeClass: "version-sunset",
    trigger,
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2027-01-01",
    severity: "high",
    migrationNote: "m",
    sources: ["https://shopify.dev"],
    status: "verified",
  });
  const verdicts = (a: Advisory, sites: CallSite[]) => {
    const m = matchAdvisories(createApiLock({ callSites: sites, declared: [] }, "t"), [a], { now: new Date("2026-10-30") });
    return [...m.affected.map((f) => `affected ${f.callSite.line} ${f.reasons[0]}`), ...m.possible.map((f) => `possible ${f.callSite.line}`), ...m.exposed.map((f) => `exposed ${f.callSite.line}`)].sort();
  };

  it("affects calls whose document selects the field, exposes the rest, and is unsure of documents it cannot read", () => {
    line = 0;
    const sites = [site("query { automaticDiscounts(first: 1) { nodes { id } } }"), site("query { shop { name } }"), site(null), site(undefined), site("query { shop { {X} } }")];
    expect(verdicts(advisory({ graphql: [{ field: "automaticDiscounts" }] }), sites)).toEqual([
      "affected 1 selects automaticDiscounts in its GraphQL document",
      "exposed 2",
      "possible 3",
      "possible 4",
      "possible 5",
    ]);
  });

  it("can be limited to mutations", () => {
    line = 0;
    const sites = [site("query { marketCurrencySettingsUpdate { id } }"), site("mutation { marketCurrencySettingsUpdate(input: {}) { userErrors { field } } }")];
    expect(verdicts(advisory({ graphql: [{ field: "marketCurrencySettingsUpdate", operation: "mutation" }] }), sites)).toEqual([
      "affected 2 selects marketCurrencySettingsUpdate in its GraphQL mutation",
      "exposed 1",
    ]);
  });
});
