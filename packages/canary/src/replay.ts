import { readFileSync } from "node:fs";
import { HTTP_METHODS } from "@shapi/core";
import { ShapeStore, diffShapes, inferShape, providerSalt, toWitness, type ShapeDiff, type StoredObservation, type Witness } from "@shapi/shapes";
import { z } from "zod";

/** A recorded sequence of responses from one endpoint, replayed through the canary pipeline. */
export const RecordingSchema = z.object({
  provider: z.string(),
  method: z.enum(HTTP_METHODS),
  endpoint: z.string().startsWith("/"),
  note: z.string().optional(),
  sources: z.array(z.url()).default([]),
  /**
   * How long the recording can be trusted without checking it against the live API, in days (`90d`). Past that, its
   * latest response is compared with the latest canary observation of the endpoint (A-02).
   */
  expiresIn: z.string().regex(/^[1-9]\d*d$/).default("90d"),
  observations: z
    .array(
      z.object({
        observedAt: z.iso.datetime(),
        status: z.number().int(),
        headers: z.record(z.string(), z.string()).default({}),
        body: z.string().default(""),
      }),
    )
    .min(2),
});
export type Recording = z.infer<typeof RecordingSchema>;

export interface ReplayResult {
  recording: Recording;
  observations: StoredObservation[];
  /** Each recorded response as a shape witness (A-01), source "replay". */
  witnesses: Witness[];
  /** Latest observation and the last one with a different shape; undefined if the shape never changed. */
  before?: StoredObservation;
  after: StoredObservation;
  diff?: ShapeDiff;
}

export function loadRecording(file: string): Recording {
  return RecordingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Store every recorded response as a shape (source "replay") and diff the last change, exactly as a live canary would. */
export function replay(recording: Recording, store: ShapeStore, secret: string): ReplayResult {
  const salt = providerSalt(recording.provider, secret);
  const { provider, method, endpoint } = recording;
  const observations = recording.observations.map((o) =>
    store.record({
      provider,
      method,
      endpoint,
      observedAt: o.observedAt,
      source: "replay",
      shape: inferShape({ status: o.status, headers: o.headers, body: o.body }, { salt }),
    }),
  );
  const witnesses = recording.observations.map((o) =>
    toWitness({ status: o.status, headers: o.headers, body: o.body }, { provider, method, pathTemplate: endpoint, source: "replay", observedAt: o.observedAt, allow: { keys: "*" } }),
  );
  const after = store.latest(provider, method, endpoint, "replay")!;
  const before = store.previousDistinct(provider, method, endpoint, "replay");
  return { recording, observations, witnesses, after, before, ...(before ? { diff: diffShapes(before.shape, after.shape) } : {}) };
}

/**
 * A recording past its `expiresIn` (execution plan A-02), checked the way Hoverfly checks a simulation against the real
 * service:
 * - `fresh`: within its expiry;
 * - `revalidated`: expired, and the live API's latest canary shape still matches the recording's latest response;
 * - `stale`: expired, and the live API answers with a different shape now;
 * - `unchecked`: expired, and no canary observes the endpoint, so nothing can confirm it.
 */
export type FixtureState = "fresh" | "revalidated" | "stale" | "unchecked";

export interface FixtureStatus {
  provider: string;
  method: string;
  endpoint: string;
  /** The recording's latest response. */
  recordedAt: string;
  expiresAt: string;
  state: FixtureState;
  detail: string;
}

/** `recordedHash`: the shape hash of the recording's latest response (`replay().after.shapeHash`), with the canary's secret. */
export function fixtureStatus(recording: Recording, recordedHash: string, live: { observedAt: string; shapeHash: string } | undefined, now: Date): FixtureStatus {
  const recordedAt = recording.observations.map((o) => o.observedAt).sort().at(-1)!;
  const expiresAt = new Date(Date.parse(recordedAt) + Number.parseInt(recording.expiresIn, 10) * 86_400_000).toISOString();
  const base = { provider: recording.provider, method: recording.method, endpoint: recording.endpoint, recordedAt, expiresAt };
  if (now.toISOString() <= expiresAt) return { ...base, state: "fresh", detail: `recorded ${recordedAt.slice(0, 10)}, trusted until ${expiresAt.slice(0, 10)}` };
  if (!live || live.observedAt <= recordedAt) return { ...base, state: "unchecked", detail: "expired, and no canary has observed the endpoint since" };
  return live.shapeHash === recordedHash
    ? { ...base, state: "revalidated", detail: `the canary saw the same shape on ${live.observedAt.slice(0, 10)}` }
    : { ...base, state: "stale", detail: `the canary saw a different shape on ${live.observedAt.slice(0, 10)}: contract tests built from this recording may no longer match the API` };
}
