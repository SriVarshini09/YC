import { describe, expect, it } from "vitest";
import { apiOf, breakingChanges, churnIndex, normalizeSpec, parseRawLog, type VersionPair } from "@shapi/bench";

// Execution plan P-17: the APIs.guru spec churn index.
describe("normalizeSpec", () => {
  it("maps Swagger 2.0 definitions, shared parameters and parameter types onto the OpenAPI 3 shape", () => {
    const v1 = {
      swagger: "2.0",
      info: { version: "1" },
      parameters: { kind: { name: "kind", in: "query", type: "string", enum: ["a", "b"] } },
      paths: {
        "/pets": { get: { parameters: [{ $ref: "#/parameters/kind" }, { name: "limit", in: "query", type: "integer" }], responses: { "200": { schema: { $ref: "#/definitions/Pet" } } } } },
        "/toys": { get: { responses: { "200": {} } } },
      },
      definitions: { Pet: { type: "object", properties: { name: { type: "string" }, age: { type: "integer" } } } },
    };
    const v2 = {
      ...v1,
      parameters: { kind: { name: "kind", in: "query", type: "string", enum: ["a"] } },
      paths: { "/pets": { get: { parameters: [{ $ref: "#/parameters/kind" }, { name: "limit", in: "query", type: "integer", required: true }], responses: { "200": {} } } } },
      definitions: { Pet: { type: "object", properties: { name: { type: "integer" } } } },
    };
    const [a, b] = [normalizeSpec(v1)!, normalizeSpec(v2)!];
    expect(a.components.schemas.Pet).toBeDefined();
    expect(breakingChanges(a, b).map((c) => `${c.kind} ${c.operation ?? c.schema} ${c.field ?? ""}`.trim()).sort()).toEqual([
      "enum-value-removed GET /pets kind",
      "operation-removed GET /toys",
      "parameter-required GET /pets limit",
      "property-removed Pet age",
      "property-type-changed Pet name",
    ]);
  });

  it("reads OpenAPI 3 as it is, and gives undefined for a document without paths", () => {
    const spec = normalizeSpec({ openapi: "3.0.0", info: { version: "2" }, paths: { "/a": { get: { responses: {} } } }, components: { schemas: { A: {} } } })!;
    expect(Object.keys(spec.components.schemas)).toEqual(["A"]);
    expect(normalizeSpec({ openapi: "3.0.0" })).toBeUndefined();
    expect(normalizeSpec("text")).toBeUndefined();
  });

  it("doesn't count added enum values or new statuses as breaking", () => {
    const base = { openapi: "3.0.0", info: { version: "1" }, paths: {}, components: { schemas: { A: { properties: { s: { type: "string", enum: ["x"] } } } } } };
    const more = { ...base, components: { schemas: { A: { properties: { s: { type: "string", enum: ["x", "y"] } } } } } };
    expect(breakingChanges(normalizeSpec(base)!, normalizeSpec(more)!)).toEqual([]);
  });
});

describe("parseRawLog", () => {
  it("keeps modified spec files, oldest first, and skips added, deleted and other files", () => {
    const o = "a".repeat(40);
    const n = "b".repeat(40);
    const log = [
      "@2222222 2021-02-01T00:00:00+00:00",
      "",
      `:100644 100644 ${o} ${n} M\tAPIs/stripe.com/2020-08-27/openapi.yaml`,
      `:100644 100644 ${o} ${n} M\tAPIs/stripe.com/2020-08-27/README.md`,
      `:000000 100644 ${"0".repeat(40)} ${n} A\tAPIs/new.com/1/openapi.yaml`,
      "@1111111 2021-01-01T00:00:00+00:00",
      `:100644 100644 ${n} ${o} M\tAPIs/googleapis.com/drive/v3/swagger.yaml`,
    ].join("\n");
    expect(parseRawLog(log).map((e) => `${e.commit} ${e.path}`)).toEqual(["1111111 APIs/googleapis.com/drive/v3/swagger.yaml", "2222222 APIs/stripe.com/2020-08-27/openapi.yaml"]);
    expect(apiOf("APIs/googleapis.com/drive/v3/openapi.yaml")).toEqual({ provider: "googleapis.com", api: "googleapis.com/drive" });
    expect(apiOf("APIs/stripe.com/2020-08-27/openapi.yaml")).toEqual({ provider: "stripe.com", api: "stripe.com" });
  });
});

describe("churnIndex", () => {
  it("ranks providers with enough versions by the low end of their breaking rate's interval", () => {
    const pairs = (provider: string, n: number, breaking: number): VersionPair[] =>
      Array.from({ length: n }, (_, i) => ({ path: `APIs/${provider}/v${i % 2}/openapi.yaml`, commit: `c${i}`, date: `2021-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, breaking: i < breaking ? 2 : 0 }));
    const index = churnIndex([...pairs("a.com", 20, 10), ...pairs("b.com", 10, 9), ...pairs("c.com", 5, 5)], 10);
    expect(index.map((p) => `${p.provider} ${p.breakingPairs}/${p.pairs}`)).toEqual(["b.com 9/10", "a.com 10/20"]);
    expect(index[1]).toMatchObject({ apis: 1, breakingChanges: 20, first: "2021-01-01", last: "2021-01-20", rate: { k: 10, n: 20, rate: 0.5 } });
  });
});
