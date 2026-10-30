import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_MIN_KEYS, WITNESS_SCHEMA, WitnessSchema, shapeId, toWitness, witnessJsonSchema, witnessToShape, type WitnessContext } from "../src/index";

describe("witnessToShape (V-03)", () => {
  it("turns a witness back into a response shape a contract-test stub can be built from", () => {
    const body = JSON.stringify({ id: 7, state: "open", owner: { email: null }, rates: { "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90": 1, "4e3b0d2f-6c8e-4f9b-8d32-8e5f6a7b9c01": 2, "5f4c1e30-7d9f-4a0c-9e43-9f6a7b8c0d12": 3 } });
    const w = toWitness({ status: 201, headers: { "content-type": "application/json" }, body }, { provider: "acme", method: "POST", pathTemplate: "/x", source: "fixture", observedAt: "2026-10-30T00:00:00.000Z", allow: { keys: "*", enums: ["$.state"] } });
    const shape = witnessToShape(w);
    expect(shape).toMatchObject({ status: 201, headers: { "content-type": "application/json" }, body: { kind: "json", rootType: "object" } });
    expect(Object.fromEntries(shape.body.fields.map((f) => [f.path, [f.types, f.classes]]))).toEqual({
      id: [["integer"], []],
      owner: [["object"], []],
      "owner.email": [["null"], []],
      rates: [["object"], []],
      "rates.key": [["integer"], []],
      state: [["string"], ["token"]],
    });
    const empty = witnessToShape(toWitness({ status: 204, headers: {}, body: "" }, { provider: "acme", method: "POST", pathTemplate: "/x", source: "fixture", observedAt: "2026-10-30T00:00:00.000Z", allow: { keys: "*" } }));
    expect(empty).toMatchObject({ status: 204, headers: {}, body: { kind: "empty", fields: [] } });
  });
});

const ctx: WitnessContext = { provider: "github", method: "GET", pathTemplate: "/repos/{owner}/{repo}/pulls", source: "canary", observedAt: "2026-10-30T10:00:00.000Z", allow: { keys: "*" } };
const pulls = JSON.stringify([
  { id: 1296269, node_id: "MDExOlB1bGxSZXF1ZXN0MQ==", state: "open", title: "Fix the bug for alice@example.com", user: { login: "octocat", email: "alice@example.com" }, created_at: "2026-01-02T03:04:05Z", merged_at: null },
  { id: 1296270, node_id: "MDExOlB1bGxSZXF1ZXN0Mg==", state: "closed", title: "Another change", user: { login: "hubot", email: null }, created_at: "2026-01-03T03:04:05Z", merged_at: "2026-01-04T00:00:00Z" },
]);
const headers = { "Content-Type": "application/json; charset=utf-8", Date: "Thu, 30 Oct 2026 10:00:00 GMT", "X-RateLimit-Remaining": "4999", "X-GitHub-Api-Version-Selected": "2022-11-28", ETag: 'W/"abc"', Link: "<https://api.github.com/x?page=2>; rel=next" };
const response = { status: 200, headers, body: pulls };

describe("shape witness (A-01)", () => {
  it("records the contract, never the values", () => {
    const w = toWitness(response, ctx);
    expect(WitnessSchema.parse(w)).toEqual(w);
    expect(w).toMatchObject({ schema: WITNESS_SCHEMA, provider: "github", apiVersion: "2022-11-28", status: 200, deprecation: null, sunset: null, dropped: 0 });
    expect(w.headerNames).toEqual(["content-type", "link", "x-github-api-version-selected"]);
    expect(w.body.fields).toEqual({
      $: "array",
      "$[]": "object",
      "$[].created_at": "string:datetime",
      "$[].id": "integer",
      "$[].merged_at": "null|string:datetime",
      "$[].node_id": "string:text",
      "$[].state": "string:token",
      "$[].title": "string:text",
      "$[].user": "object",
      "$[].user.email": "null|string:email",
      "$[].user.login": "string:token",
    });
    const text = JSON.stringify(w);
    for (const value of ["alice@example.com", "octocat", "1296269", "Fix the bug", "open", "MDExOlB1bGxSZXF1ZXN0MQ"]) expect(text).not.toContain(value);
  });

  it("gives the same shape_id on every run of the same response, from any source", () => {
    const a = toWitness(response, ctx);
    const b = toWitness(response, { ...ctx, source: "replay", observedAt: "2026-11-01T00:00:00.000Z" });
    expect(a.shapeId).toMatch(/^[0-9a-f]{64}$/);
    expect(b.shapeId).toBe(a.shapeId);
    expect(shapeId(a)).toBe(a.shapeId);
    // More items with the same structure: still the same contract.
    const longer = JSON.stringify([...JSON.parse(pulls), ...JSON.parse(pulls)]);
    expect(toWitness({ ...response, body: longer }, ctx).shapeId).toBe(a.shapeId);
    // A changed type is a different shape.
    expect(toWitness({ ...response, body: pulls.replace('"id":1296269', '"id":"1296269"') }, ctx).shapeId).not.toBe(a.shapeId);
  });

  it("keeps clear enum values only for the paths the allowlist names", () => {
    const w = toWitness(response, { ...ctx, allow: { keys: "*", enums: ["$[].state"] } });
    expect(w.body.fields["$[].state"]).toBe("enum{closed,open}");
    expect(w.body.fields["$[].user.login"]).toBe("string:token");
  });

  it("fails closed: keys outside the allowlist are dropped and counted", () => {
    const none = toWitness(response, { ...ctx, allow: { keys: [] } });
    expect(none.body.fields).toEqual({ $: "array" });
    expect(none.dropped).toBe(1);
    const some = toWitness(response, { ...ctx, allow: { keys: ["$[].user.login", "$[].state"] } });
    expect(Object.keys(some.body.fields)).toEqual(["$", "$[]", "$[].state", "$[].user", "$[].user.login"]);
    expect(some.dropped).toBe(6);
  });

  it("collapses objects keyed by data into maps, without recording their keys", () => {
    const byId = JSON.stringify({ users: { "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90": { plan: "pro" }, "4e3b0d2f-6c8e-4f9b-8d32-8e5f6a7b9c01": { plan: "free" }, "5f4c1e30-7d9f-4a0c-9e43-9f6a7b8c0d12": { plan: "pro" } }, count: 3 });
    const w = toWitness({ status: 200, headers: {}, body: byId }, ctx);
    expect(w.mapCollapsed).toEqual(["$.users"]);
    expect(w.body.fields).toMatchObject({ "$.users": "object", "$.users{}": "object", "$.users{}.plan": "string:token" });
    expect(JSON.stringify(w)).not.toContain("3f2a9c1e");
    const many = Object.fromEntries(Array.from({ length: MAP_MIN_KEYS + 1 }, (_, i) => [`currency_${i}`, i]));
    expect(toWitness({ status: 200, headers: {}, body: JSON.stringify({ rates: many }) }, ctx).mapCollapsed).toEqual(["$.rates"]);
  });

  it("reads RFC 9745 Deprecation and RFC 8594 Sunset, and the requested version when no header names one", () => {
    const w = toWitness(
      { status: 200, headers: { deprecation: "@1735689600", sunset: "Wed, 21 Jan 2027 00:00:00 GMT" }, body: "" },
      { ...ctx, provider: "quickbooks", pathTemplate: "/v3/company/{realmId}/companyinfo/{id}", apiVersion: "65" },
    );
    expect(w).toMatchObject({ deprecation: "2025-01-01T00:00:00.000Z", sunset: "2027-01-21T00:00:00.000Z", apiVersion: "65", body: { kind: "empty", fields: {} } });
  });

  it("is published as JSON Schema at its $id (UPDATE_SCHEMA=1 rewrites it)", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site", "public", "schema", "witness-v1.json");
    const generated = JSON.stringify(witnessJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA || !existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, generated);
    }
    expect(readFileSync(file, "utf8")).toBe(generated);
    expect(JSON.parse(generated)).toMatchObject({ $id: WITNESS_SCHEMA });
  });
});
