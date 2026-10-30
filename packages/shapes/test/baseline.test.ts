import { describe, expect, it } from "vitest";
import { churningFields, inferShape, stableHash, stableShape } from "../src/index";

// Execution plan CN-04: an endpoint's natural churn, learned from its history.
const shape = (body: unknown, status = 200) => inferShape({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { salt: "t" });

describe("churningFields", () => {
  it("learns a field that came and went at least twice, not one removed for good", () => {
    const history = [shape({ id: 1, discount: 5 }), shape({ id: 2 }), shape({ id: 3, discount: 1 }), shape({ id: 4, gone: true }), shape({ id: 5 })];
    // discount: present, absent, present, absent, absent = 3 flips; gone: absent, absent, absent, present, absent = 2 flips.
    expect([...churningFields(history).values()].sort()).toEqual(["discount", "gone"]);
    const removed = [shape({ id: 1, legacy: 1 }), shape({ id: 2, legacy: 1 }), shape({ id: 3 }), shape({ id: 4 })];
    expect(churningFields(removed).size).toBe(0);
  });

  it("only learns from successful JSON responses", () => {
    expect(churningFields([shape({ a: 1 }), shape({ error: "x" }, 500), shape({ a: 1 }), shape({ error: "y" }, 500)]).size).toBe(0);
  });

  it("compares shapes without the churning fields", () => {
    const churn = churningFields([shape({ id: 1, discount: 5 }), shape({ id: 2 }), shape({ id: 3, discount: 1 })]);
    expect(stableHash(shape({ id: 9, discount: 2 }), churn)).toBe(stableHash(shape({ id: 9 }), churn));
    expect(stableShape(shape({ id: 9, discount: 2 }), churn).body.fields.map((f) => f.path)).toEqual(["id"]);
    expect(stableHash(shape({ id: 9 }), churn)).not.toBe(stableHash(shape({ id: "x" }), churn));
  });
});
