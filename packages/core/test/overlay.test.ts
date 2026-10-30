import { describe, expect, it } from "vitest";
import { applyOverlay, operationsFor, type Overlay } from "@shapi/core";

// Execution plan S-05: the overlay applier and the operations an advisory covers in a spec.
const overlay = (actions: Overlay["actions"]): Overlay => ({ overlay: "1.0.0", info: { title: "t", version: "1" }, extends: "x", actions });

describe("applyOverlay", () => {
  const spec = { paths: { "/a/{id}": { get: { responses: { "200": {}, "204": {} } } }, "/it's": { post: {} } } };

  it("removes and merges at bracket and dot targets, and leaves the input alone", () => {
    const { result, unmatched } = applyOverlay(spec, overlay([
      { target: "$.paths['/a/{id}'].get.responses['204']", remove: true },
      { target: "$.paths['/a/{id}'].get", update: { "x-shapi-advisory": "a", responses: { "201": { description: "d" } } } },
      { target: "$.paths['/it\\'s'].post", remove: true },
    ]));
    expect(unmatched).toEqual([]);
    expect(result.paths["/a/{id}"].get).toEqual({ responses: { "200": {}, "201": { description: "d" } }, "x-shapi-advisory": "a" });
    expect(result.paths["/it's"]).toEqual({});
    expect(spec.paths["/a/{id}"].get.responses).toHaveProperty("204");
  });

  it("lists the targets that match nothing, and refuses JSONPath it does not read", () => {
    expect(applyOverlay(spec, overlay([{ target: "$.paths['/b'].get", remove: true }])).unmatched).toEqual(["$.paths['/b'].get"]);
    expect(() => applyOverlay(spec, overlay([{ target: "$..get", remove: true }]))).toThrow(/unsupported JSONPath/);
  });
});

describe("operationsFor", () => {
  it("matches the advisory's pattern against the server path plus the spec path, and its method", () => {
    const file = { base: "/v1", paths: { "/assistants": { get: {}, post: {} }, "/assistants/{assistant_id}": { delete: {} }, "/chat/completions": { post: {} } } };
    expect(operationsFor({ endpoint: { method: "*", path: "/v1/assistants/**" } }, file)).toEqual([["/assistants", "get"], ["/assistants", "post"], ["/assistants/{assistant_id}", "delete"]]);
    expect(operationsFor({ endpoint: { method: "POST", path: "/v1/chat/completions" } }, file)).toEqual([["/chat/completions", "post"]]);
  });
});
