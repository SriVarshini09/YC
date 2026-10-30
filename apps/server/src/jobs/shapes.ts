import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadRecording, replay } from "@shapi/canary";
import { pathMatches, type Advisory } from "@shapi/core";
import { PgShapeStore, type Db } from "@shapi/db";
import { ShapeStore, witnessToShape, type ResponseShape } from "@shapi/shapes";

export interface AdvisoryShapes {
  before: ResponseShape;
  after: ResponseShape;
  /** Where they came from, shown in the PR: a canary source, or a recording file. */
  source: string;
  /** For a recording: the shape ids of the witnesses the shapes were built from (V-03), shown in the PR. */
  witnesses?: { before: string; after: string };
}

const endpointOf = (advisory: Advisory, provider: string, method: string, endpoint: string) =>
  provider === advisory.provider && pathMatches(endpoint, advisory.endpoint) && (advisory.endpoint.method === "*" || method === advisory.endpoint.method);

/**
 * The response the code was written against and the one the provider sends now: from SHAPI's own
 * canary observations first, then from the recordings shipped with SHAPI. Never from customer traffic.
 */
export async function shapesFor(db: Db, advisory: Advisory, recordingsDir: string, secret: string): Promise<AdvisoryShapes | undefined> {
  const store = new PgShapeStore(db);
  for (const e of await store.endpoints()) {
    if (!endpointOf(advisory, e.provider, e.method, e.endpoint)) continue;
    const after = await store.latest(e.provider, e.method, e.endpoint, e.source);
    const before = await store.previousDistinct(e.provider, e.method, e.endpoint, e.source);
    if (before && after) return { before: before.shape, after: after.shape, source: e.source };
  }
  if (!existsSync(recordingsDir)) return undefined;
  for (const name of readdirSync(recordingsDir).filter((f) => f.endsWith(".json")).sort()) {
    const recording = loadRecording(path.join(recordingsDir, name));
    if (!endpointOf(advisory, recording.provider, recording.method, recording.endpoint)) continue;
    const memory = ShapeStore.open(":memory:");
    try {
      const replayed = replay(recording, memory, secret);
      if (!replayed.before) continue;
      // The contract test's stub is built from the recorded witnesses (V-03): the last response before the change and the latest one.
      const before = replayed.witnesses.find((w) => w.observedAt === replayed.before!.observedAt);
      const after = replayed.witnesses.find((w) => w.observedAt === replayed.after.observedAt);
      if (!before || !after) return { before: replayed.before.shape, after: replayed.after.shape, source: `recording ${name}` };
      return { before: witnessToShape(before), after: witnessToShape(after), source: `recording ${name}`, witnesses: { before: before.shapeId, after: after.shapeId } };
    } finally {
      memory.close();
    }
  }
  return undefined;
}
