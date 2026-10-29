import { describe, expect, it } from "vitest";
import { diffShapes, inferShape, providerSalt } from "@shapi/shapes";

const salt = providerSalt("github", "test");
const shape = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  inferShape({ status, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? "" : JSON.stringify(body) }, { salt });
const kinds = (d: ReturnType<typeof diffShapes>) => d.changes.map((c) => `${c.impact}:${c.kind}:${c.path ?? ""}`);

describe("diffShapes", () => {
  it("reports nothing for identical contracts", () => {
    const d = diffShapes(shape(200, { id: 1, items: [{ a: "x" }] }), shape(200, { id: 2, items: [{ a: "y" }, { a: "z" }] }));
    expect(d.breaking).toBe(false);
    expect(d.changes.filter((c) => c.impact !== "informational")).toEqual([]);
  });

  it("classifies a 2xx status change as a breaking status-code change", () => {
    const d = diffShapes(shape(204), shape(200, { workflow_run_id: 1 }));
    expect(d.breaking).toBe(true);
    expect(d.changes[0]).toMatchObject({ kind: "status-code", impact: "breaking", changeClass: "status-code", from: 204, to: 200, detail: "status 204 → 200" });
    expect(d.changes.find((c) => c.kind === "body-kind")).toMatchObject({ impact: "informational", from: "empty", to: "json" });
  });

  it("maps success to 401/403 as auth, 404/410 as sunset, and 5xx as informational", () => {
    expect(diffShapes(shape(200, { a: 1 }), shape(403, { message: "Forbidden" })).changes[0]).toMatchObject({ changeClass: "auth", impact: "breaking" });
    expect(diffShapes(shape(200, { a: 1 }), shape(410, { message: "Gone" })).changes[0]).toMatchObject({ changeClass: "version-sunset" });
    const outage = diffShapes(shape(200, { a: 1 }), shape(503, { message: "x" }));
    expect(outage.breaking).toBe(false);
    // fields are not compared across the success/error boundary
    expect(outage.changes.some((c) => c.kind === "field-removed")).toBe(false);
  });

  it("finds removed, added, retyped and newly nullable fields, reporting only the top of a removed subtree", () => {
    const before = shape(200, { id: 1, name: "a", owner: { login: "x", id: 2 }, count: 3, closed_at: "2026-01-01T00:00:00Z" });
    const after = shape(200, { id: "1", name: "a", total: 4, count: 3, closed_at: null });
    expect(kinds(diffShapes(before, after))).toEqual([
      "breaking:became-nullable:closed_at",
      "breaking:type-changed:id",
      "breaking:field-removed:owner",
      "non-breaking:field-added:total",
    ]);
    const retyped = diffShapes(before, after).changes.find((c) => c.kind === "type-changed");
    expect(retyped).toMatchObject({ changeClass: "field-rename", from: ["integer"], to: ["string"] });
  });

  it("flags enum values not seen before on enum-like fields", () => {
    const before = shape(200, { runs: ["success", "failure", "success", "failure"].map((conclusion) => ({ conclusion })) });
    const after = shape(200, { runs: [{ conclusion: "success" }, { conclusion: "startup_failure" }] });
    const d = diffShapes(before, after);
    expect(d.changes).toEqual([
      expect.objectContaining({ kind: "enum-value-added", impact: "breaking", changeClass: "enum-added", path: "runs[].conclusion", detail: "field runs[].conclusion has 1 value not seen before" }),
    ]);
    expect(JSON.stringify(d)).not.toContain("startup_failure");
  });

  it("does not treat a field seen once per value as an enum", () => {
    const d = diffShapes(shape(200, { runs: [{ conclusion: "success" }, { conclusion: "failure" }] }), shape(200, { runs: [{ conclusion: "skipped" }] }));
    expect(d.changes).toEqual([]);
  });

  it("treats content-type changes as breaking and deprecation headers as sunset signals", () => {
    const d = diffShapes(shape(200, { a: 1 }), shape(200, { a: 1 }, { "content-type": "text/csv", deprecation: "true", "x-new": "1" }));
    expect(kinds(d)).toEqual([
      "breaking:header-changed:content-type",
      "informational:header-added:deprecation",
      "informational:header-added:x-new",
    ]);
    expect(d.changes[1]).toMatchObject({ changeClass: "version-sunset" });
  });

  it("works on redacted shapes using path hashes", () => {
    const d = diffShapes(shape(200, { secret_field: 1 }), shape(200, {}));
    expect(d.changes[0]).toMatchObject({ kind: "field-removed", path: "secret_field" });
  });
});

describe("diffShapes: changes that are not a contract change", () => {
  it("treats integer and number as one JSON type", () => {
    expect(kinds(diffShapes(shape(200, { price: 10 }), shape(200, { price: 10.5 })))).toEqual([]);
    expect(kinds(diffShapes(shape(200, { price: 10.5 }), shape(200, { price: 11 })))).toEqual([]);
    expect(kinds(diffShapes(shape(200, { price: 10 }), shape(200, { price: "10" })))).toEqual(["breaking:type-changed:price"]);
  });

  it("does not read an array that came back empty as its items' fields removed", () => {
    expect(kinds(diffShapes(shape(200, { items: [{ id: 1 }] }), shape(200, { items: [] })))).toEqual([]);
    expect(kinds(diffShapes(shape(200, [{ id: 1 }]), shape(200, [])))).toEqual([]);
    expect(kinds(diffShapes(shape(200, { items: [{ id: 1 }], total: 1 }), shape(200, { items: [] })))).toEqual(["breaking:field-removed:total"]);
  });

  it("tells a dotted key from a nested object", () => {
    expect(kinds(diffShapes(shape(200, { "a.b": 1 }), shape(200, { a: { b: 1 } })))).toEqual(["breaking:field-removed:a\\.b", "non-breaking:field-added:a"]);
  });
});
