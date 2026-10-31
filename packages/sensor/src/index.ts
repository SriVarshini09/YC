import { matchEndpoint, SENSOR_ENDPOINTS, type SensorEndpoint } from "./endpoints";
import { sensorShape, shapeKey, WIRE_VERSION, type SensorBatch, type SensorObservation } from "./shape";

export { matchEndpoint, patternRegex, SENSOR_ENDPOINTS, type SensorEndpoint } from "./endpoints";
export { SIGNAL_HEADERS, WIRE_VERSION, sensorShape, shapeKey, type JsonType, type SensorBatch, type SensorObservation, type SensorShape } from "./shape";

/**
 * SHAPI's opt-in traffic add-on for Node (execution plan F-01). It wraps `fetch`, and for each response from an
 * endpoint a SHAPI advisory names it records the value-free shape: status, field names and JSON types, and the
 * deprecation and version headers. Requests to anything else are not looked at. Shapes are counted in memory and
 * sent in one batch every `flushMs`, or printed instead with `dryRun`, so you can see exactly what would leave.
 *
 *   import { installSensor } from "@shapi/sensor";
 *   installSensor({ token: process.env.SHAPI_SENSOR_TOKEN, dryRun: true });
 */
export interface SensorOptions {
  /** The account's sensor token (web app → Settings → Traffic sensor). Not needed with `dryRun`. */
  token?: string;
  /** Print each batch instead of sending it. */
  dryRun?: boolean;
  /** Where batches go. */
  endpoint?: string;
  flushMs?: number;
  /** Where dry-run batches and errors are written; console.log by default. */
  log?: (line: string) => void;
  /** Which endpoints to record; SHAPI's advisories by default. */
  endpoints?: SensorEndpoint[];
  /** For tests: the fetch to wrap and the one to send with. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface Sensor {
  /** Send (or print) what was recorded so far. */
  flush(): Promise<SensorBatch | undefined>;
  /** Restore the original fetch and stop the timer, after a last flush. */
  stop(): Promise<void>;
  /** The wrapped fetch, for code that takes one explicitly. */
  fetch: typeof globalThis.fetch;
}

export const DEFAULT_SENSOR_ENDPOINT = "https://app.shapi.dev/api/v1/sensor/observations";

export function createSensor(opts: SensorOptions = {}): Sensor {
  if (!opts.dryRun && !opts.token) throw new Error("installSensor: pass a token, or dryRun: true");
  const inner = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const endpoints = opts.endpoints ?? SENSOR_ENDPOINTS;
  const pending = new Map<string, SensorObservation>();
  /** Response bodies still being read: a flush waits for them. */
  const inflight = new Set<Promise<void>>();

  const record = (e: SensorEndpoint, method: string, res: Response, text: string) => {
    const shape = sensorShape(res.status, res.headers.entries(), text);
    const key = `${e.provider} ${method} ${e.path} ${shapeKey(shape)}`;
    const at = now().toISOString();
    const seen = pending.get(key);
    if (seen) {
      seen.count++;
      seen.lastSeen = at;
    } else pending.set(key, { provider: e.provider, method, endpoint: e.path, shape, count: 1, firstSeen: at, lastSeen: at });
  };

  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const res = await inner(input, init);
    try {
      const req = input instanceof Request ? input : undefined;
      const url = new URL(req?.url ?? String(input));
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const e = matchEndpoint(method, url, endpoints);
      // Read a copy, so the caller's response is untouched.
      if (e) {
        const reading = res.clone().text().then((text) => record(e, method, res, text), () => undefined);
        inflight.add(reading);
        void reading.finally(() => inflight.delete(reading));
      }
    } catch {
      // The sensor never breaks the request.
    }
    return res;
  };

  const flush = async (): Promise<SensorBatch | undefined> => {
    await Promise.all([...inflight]);
    if (pending.size === 0) return undefined;
    const batch: SensorBatch = { v: WIRE_VERSION, sdk: "node", observations: [...pending.values()] };
    pending.clear();
    if (opts.dryRun) {
      log(`[shapi-sensor] dry run, would send: ${JSON.stringify(batch)}`);
      return batch;
    }
    try {
      const res = await inner(opts.endpoint ?? DEFAULT_SENSOR_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` }, body: JSON.stringify(batch) });
      if (!res.ok) log(`[shapi-sensor] upload failed: HTTP ${res.status}`);
    } catch (err) {
      log(`[shapi-sensor] upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return batch;
  };

  const timer = setInterval(() => void flush(), opts.flushMs ?? 60_000);
  timer.unref?.();
  return {
    fetch: wrapped,
    flush,
    async stop() {
      clearInterval(timer);
      await flush();
    },
  };
}

/** Wrap the global `fetch` with a sensor. `stop()` puts the original back. */
export function installSensor(opts: SensorOptions = {}): Sensor {
  const original = globalThis.fetch;
  const sensor = createSensor({ ...opts, fetch: opts.fetch ?? original.bind(globalThis) });
  globalThis.fetch = sensor.fetch;
  return {
    ...sensor,
    async stop() {
      globalThis.fetch = original;
      await sensor.stop();
    },
  };
}
