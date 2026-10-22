import { readFileSync } from "node:fs";
import { HTTP_METHODS } from "@shapi/core";
import { ShapeStore, diffShapes, inferShape, providerSalt, type ShapeDiff, type StoredObservation } from "@shapi/shapes";
import { z } from "zod";

/** A recorded sequence of responses from one endpoint, replayed through the canary pipeline. */
export const RecordingSchema = z.object({
  provider: z.string(),
  method: z.enum(HTTP_METHODS),
  endpoint: z.string().startsWith("/"),
  note: z.string().optional(),
  sources: z.array(z.url()).default([]),
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
  const after = store.latest(provider, method, endpoint)!;
  const before = store.previousDistinct(provider, method, endpoint);
  return { recording, observations, after, before, ...(before ? { diff: diffShapes(before.shape, after.shape) } : {}) };
}
