import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ShapeStore } from "@shapi/shapes";
import { RecordingSchema, fixtureStatus, loadRecording, replay } from "@shapi/canary";

// Execution plan A-02: a recording expires, and is then checked against the live API's latest canary shape.
const recording = loadRecording(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json"));
const memory = ShapeStore.open(":memory:");
const { after } = replay(recording, memory, "s");
memory.close();
const recordedAt = recording.observations.map((o) => o.observedAt).sort().at(-1)!;
const day = (d: string) => new Date(`${d}T12:00:00Z`);

describe("recording expiry and drift (A-02)", () => {
  it("trusts a recording for 90 days by default, or its own expiresIn", () => {
    expect(recording.expiresIn).toBe("90d");
    expect(RecordingSchema.safeParse({ ...recording, expiresIn: "30d" }).success).toBe(true);
    for (const bad of ["30", "0d", "1w", "-3d"]) expect(RecordingSchema.safeParse({ ...recording, expiresIn: bad }).success, bad).toBe(false);
  });

  it("is fresh within its expiry, whatever the canary says", () => {
    const status = fixtureStatus(recording, after.shapeHash, { observedAt: "2026-01-01T00:00:00Z", shapeHash: "other" }, new Date(recordedAt));
    expect(status).toMatchObject({ state: "fresh", recordedAt, expiresAt: new Date(Date.parse(recordedAt) + 90 * 86_400_000).toISOString() });
  });

  it("past its expiry: unchecked without a newer canary observation, revalidated or stale with one", () => {
    const now = day("2026-10-30");
    expect(fixtureStatus(recording, after.shapeHash, undefined, now).state).toBe("unchecked");
    // A canary observation older than the recording proves nothing.
    expect(fixtureStatus(recording, after.shapeHash, { observedAt: "2025-01-01T00:00:00Z", shapeHash: after.shapeHash }, now).state).toBe("unchecked");
    expect(fixtureStatus(recording, after.shapeHash, { observedAt: "2026-10-29T09:00:00Z", shapeHash: after.shapeHash }, now)).toMatchObject({ state: "revalidated", detail: "the canary saw the same shape on 2026-10-29" });
    const stale = fixtureStatus(recording, after.shapeHash, { observedAt: "2026-10-29T09:00:00Z", shapeHash: "different" }, now);
    expect(stale.state).toBe("stale");
    expect(stale.detail).toContain("may no longer match the API");
    // A shorter expiry makes a recent recording expire sooner.
    expect(fixtureStatus({ ...recording, expiresIn: "1d" }, after.shapeHash, undefined, new Date(Date.parse(recordedAt) + 2 * 86_400_000)).state).toBe("unchecked");
  });
});
