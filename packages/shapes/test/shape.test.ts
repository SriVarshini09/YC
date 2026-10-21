import { describe, expect, it } from "vitest";
import { classify, inferShape, providerSalt, redactShape, shapeHash, type ResponseShape } from "@shapi/shapes";

const salt = providerSalt("github", "test-secret");
const field = (shape: ResponseShape, path: string) => shape.body.fields.find((f) => f.path === path);

const runs = {
  total_count: 2,
  workflow_runs: [
    { id: 30433642, status: "completed", conclusion: "success", created_at: "2026-10-01T12:00:00Z", head_branch: "main", pull_requests: [] },
    { id: 30433643, status: "in_progress", conclusion: null, created_at: "2026-10-02T08:30:00Z", head_branch: "fix/login", pull_requests: [{ number: 7 }] },
  ],
};
const response = {
  status: 200,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "X-GitHub-Api-Version-Selected": "2022-11-28",
    "X-RateLimit-Remaining": "4999",
    Date: "Wed, 21 Oct 2026 10:00:00 GMT",
    ETag: 'W/"abc"',
    "X-GitHub-Media-Type": "github.v3",
  },
  body: JSON.stringify(runs),
};

describe("inferShape", () => {
  const shape = inferShape(response, { salt });

  it("records status, contract headers with values, other headers by name, and drops volatile ones", () => {
    expect(shape.status).toBe(200);
    expect(shape.headers).toEqual({ "content-type": "application/json", "x-github-api-version-selected": "2022-11-28" });
    expect(shape.headerNames).toEqual(["x-github-media-type"]);
  });

  it("walks nested objects and arrays into field paths with types, classes, null rates and array lengths", () => {
    expect(shape.body).toMatchObject({ kind: "json", rootType: "object" });
    expect(shape.body.fields.map((f) => f.path)).toEqual([
      "total_count",
      "workflow_runs",
      "workflow_runs[]",
      "workflow_runs[].conclusion",
      "workflow_runs[].created_at",
      "workflow_runs[].head_branch",
      "workflow_runs[].id",
      "workflow_runs[].pull_requests",
      "workflow_runs[].pull_requests[]",
      "workflow_runs[].pull_requests[].number",
      "workflow_runs[].status",
    ]);
    expect(field(shape, "workflow_runs[].conclusion")).toMatchObject({ types: ["null", "string"], classes: ["token"], occurrences: 2, nullRate: 0.5 });
    expect(field(shape, "workflow_runs[].created_at")).toMatchObject({ types: ["string"], classes: ["datetime"], nullRate: 0 });
    expect(field(shape, "workflow_runs[].id")).toMatchObject({ types: ["integer"], classes: ["positive"] });
    expect(field(shape, "workflow_runs[].pull_requests")?.arrayLength).toEqual({ min: 0, max: 1 });
    expect(field(shape, "workflow_runs[].status")?.valueHashes).toHaveLength(2);
  });

  it("never stores payload values", () => {
    const text = JSON.stringify(shape);
    for (const value of ["completed", "in_progress", "success", "fix/login", "30433642", "2026-10-01T12:00:00Z"]) {
      expect(text).not.toContain(value);
    }
  });

  it("hashes paths and values with the provider salt", () => {
    const other = inferShape(response, { salt: providerSalt("stripe", "test-secret") });
    expect(field(other, "total_count")?.pathHash).not.toBe(field(shape, "total_count")?.pathHash);
    expect(field(shape, "total_count")?.pathHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("handles empty and non-JSON bodies", () => {
    expect(inferShape({ status: 204, headers: {}, body: "" }, { salt })).toEqual({ status: 204, headers: {}, headerNames: [], body: { kind: "empty", fields: [] } });
    expect(inferShape({ status: 502, headers: new Headers({ "content-type": "text/html" }), body: "<html>" }, { salt }).body.kind).toBe("text");
  });

  it("redaction removes clear-text paths but keeps hashes", () => {
    const redacted = redactShape(shape);
    expect(redacted.body.fields.every((f) => f.path === undefined && f.pathHash.length === 16)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain("workflow_runs");
  });
});

describe("shapeHash", () => {
  it("is stable for the same contract even when counts and lengths differ", () => {
    const more = { ...runs, total_count: 3, workflow_runs: [...runs.workflow_runs, runs.workflow_runs[0]] };
    const a = inferShape(response, { salt });
    const b = inferShape({ ...response, body: JSON.stringify(more) }, { salt });
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("changes when the status, a field, or a type changes", () => {
    const base = shapeHash(inferShape(response, { salt }));
    expect(shapeHash(inferShape({ ...response, status: 201 }, { salt }))).not.toBe(base);
    expect(shapeHash(inferShape({ ...response, body: JSON.stringify({ ...runs, extra: true }) }, { salt }))).not.toBe(base);
    expect(shapeHash(inferShape({ ...response, body: JSON.stringify({ ...runs, total_count: "2" }) }, { salt }))).not.toBe(base);
  });
});

describe("classify", () => {
  it("classifies common value kinds", () => {
    expect(classify("2026-10-21")).toBe("date");
    expect(classify("https://api.github.com/x")).toBe("url");
    expect(classify("a@b.co")).toBe("email");
    expect(classify("cus_NffrFeUfNV2Hib")).toBe("id");
    expect(classify("6f1c0e1e-2c1a-4a4f-9a8e-0b0b0b0b0b0b")).toBe("uuid");
    expect(classify("succeeded")).toBe("token");
    expect(classify("in_progress")).toBe("token");
    expect(classify("A sentence with spaces")).toBe("text");
    expect(classify(-3)).toBe("negative");
    expect(classify(false)).toBe("false");
  });
});
