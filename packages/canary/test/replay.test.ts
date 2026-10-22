import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ShapeStore } from "@shapi/shapes";
import { RecordingSchema, loadRecording, replay, run } from "@shapi/canary";

const recordingFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json",
);

describe("replay of the GitHub workflow_dispatch incident", () => {
  const recording = loadRecording(recordingFile);

  it("stores every recorded response and finds the change between the last 204 and the first 200", () => {
    const store = ShapeStore.open(":memory:");
    const result = replay(recording, store, "test");
    expect(result.observations.map((o) => o.shape.status)).toEqual([204, 204, 200]);
    expect(result.observations.every((o) => o.source === "replay")).toBe(true);
    expect(result.before?.observedAt).toBe("2025-12-18T21:00:00Z");
    expect(result.after.observedAt).toBe("2025-12-19T09:00:00Z");
    // the two 204s are the same shape despite different rate-limit and date headers
    expect(result.observations[0]!.shapeHash).toBe(result.observations[1]!.shapeHash);
    store.close();
  });

  it("classifies it as a breaking status-code change", () => {
    const store = ShapeStore.open(":memory:");
    const { diff } = replay(recording, store, "test");
    expect(diff?.breaking).toBe(true);
    expect(diff?.changes[0]).toEqual({
      kind: "status-code",
      impact: "breaking",
      changeClass: "status-code",
      from: 204,
      to: 200,
      detail: "status 204 → 200",
    });
    expect(diff?.changes.map((c) => c.kind)).toEqual(["status-code", "body-kind", "header-added"]);
    store.close();
  });

  it("prints the classification from the CLI", async () => {
    let out = "";
    const code = await run(["node", "shapi-canary", "replay", recordingFile], { stdout: (s) => (out += s), stderr: () => {} }, {});
    expect(code).toBe(0);
    expect(out).toContain("3 observations replayed");
    expect(out).toContain("(BREAKING)");
    expect(out).toMatch(/breaking\s+status-code\s+status 204 → 200/);
  });

  it("rejects recordings with fewer than two observations", () => {
    expect(RecordingSchema.safeParse({ ...recording, observations: recording.observations.slice(0, 1) }).success).toBe(false);
  });
});
