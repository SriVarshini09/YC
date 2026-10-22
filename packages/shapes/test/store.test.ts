import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ShapeStore, inferShape, providerSalt, type Observation } from "@shapi/shapes";

const salt = providerSalt("github", "test");
const ENDPOINT = "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches";
const shape = (status: number, body: unknown) =>
  inferShape({ status, headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, { salt });
const obs = (observedAt: string, status: number, body?: unknown): Observation => ({
  provider: "github",
  method: "POST",
  endpoint: ENDPOINT,
  observedAt,
  source: "test",
  shape: shape(status, body),
});

const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ShapeStore", () => {
  it("records observations and answers latest, history and previous distinct shape", () => {
    const store = ShapeStore.open(":memory:");
    const a = store.record(obs("2025-12-18T10:00:00Z", 204));
    store.record(obs("2025-12-18T22:00:00Z", 204));
    const c = store.record(obs("2025-12-19T10:00:00Z", 200, { workflow_run_id: 1, run_url: "https://api.github.com/x" }));

    expect(store.latest("github", "POST", ENDPOINT)?.id).toBe(c.id);
    expect(store.history("github", "POST", ENDPOINT).map((o) => o.shape.status)).toEqual([200, 204, 204]);
    expect(store.history("github", "POST", ENDPOINT, { limit: 1 })).toHaveLength(1);
    expect(store.previousDistinct("github", "POST", ENDPOINT)).toMatchObject({
      shapeHash: a.shapeHash,
      observedAt: "2025-12-18T22:00:00Z",
    });
    expect(store.endpoints()).toEqual([
      { provider: "github", method: "POST", endpoint: ENDPOINT, source: "test", observations: 3, distinctShapes: 2, lastObservedAt: "2025-12-19T10:00:00Z" },
    ]);
    expect(store.latest("github", "GET", ENDPOINT)).toBeUndefined();
    store.close();
  });

  it("keeps each source's history separate when asked", () => {
    const store = ShapeStore.open(":memory:");
    const anon = store.record({ ...obs("2026-10-21T10:00:00Z", 200, { id: 1, temp_clone_token: null }), source: "canary:github:anonymous" });
    const token = store.record({ ...obs("2026-10-22T10:00:00Z", 200, { id: 1, permissions: { admin: false } }), source: "canary:github:token" });
    expect(store.latest("github", "POST", ENDPOINT)?.id).toBe(token.id);
    expect(store.latest("github", "POST", ENDPOINT, "canary:github:anonymous")?.id).toBe(anon.id);
    // without a source filter the two auth modes look like a change; within one source there is none
    expect(store.previousDistinct("github", "POST", ENDPOINT)?.id).toBe(anon.id);
    expect(store.previousDistinct("github", "POST", ENDPOINT, "canary:github:token")).toBeUndefined();
    expect(store.endpoints().map((e) => e.source)).toEqual(["canary:github:anonymous", "canary:github:token"]);
    store.close();
  });

  it("returns undefined for previousDistinct while the shape has never changed", () => {
    const store = ShapeStore.open(":memory:");
    store.record(obs("2025-12-18T10:00:00Z", 204));
    store.record(obs("2025-12-18T11:00:00Z", 204));
    expect(store.previousDistinct("github", "POST", ENDPOINT)).toBeUndefined();
    store.close();
  });

  it("persists to a file and reopens without re-migrating", () => {
    const file = path.join(dir, "nested", "shapes.db");
    const first = ShapeStore.open(file);
    first.record(obs("2025-12-18T10:00:00Z", 204));
    first.close();
    const second = ShapeStore.open(file);
    second.record(obs("2025-12-19T10:00:00Z", 204));
    expect(second.endpoints()[0]?.observations).toBe(2);
    expect(second.latest("github", "POST", ENDPOINT)?.shape.status).toBe(204);
    second.close();
  });
});
