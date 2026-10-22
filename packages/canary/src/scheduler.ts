import type { Advisory } from "@shapi/core";
import { ShapeStore, diffShapes, inferShape, providerSalt, type ShapeDiff } from "@shapi/shapes";
import { draftAdvisory } from "./draft";
import { probeSource, type Env, type Probe, type Worker } from "./probe";
import { githubWorker } from "./workers/github";
import { stripeWorker } from "./workers/stripe";

export const WORKERS: Worker[] = [githubWorker, stripeWorker];

/** Default store location, relative to the working directory (gitignored). */
export const DEFAULT_DB = ".shapi/shapes.db";

/** Dev-only fallback; set SHAPI_SHAPE_SECRET anywhere shapes leave the machine. */
export const DEV_SECRET = "shapi-dev-secret";

export interface ProbeResult {
  id: string;
  provider: string;
  method: string;
  endpoint: string;
  status?: number;
  shapeHash?: string;
  /** The shape differs from the previous observation of this endpoint. */
  changed: boolean;
  /** Hash of the previous observation, when there was one. */
  previousHash?: string;
  /** What changed, when the shape changed. */
  diff?: ShapeDiff;
  /** Draft advisory, when the change is breaking. */
  draft?: Advisory;
  error?: string;
  ms: number;
}

export interface RunOptions {
  store: ShapeStore;
  workers?: Worker[];
  env?: Env;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Only run these providers. */
  providers?: string[];
  timeoutMs?: number;
}

export interface RunReport {
  results: ProbeResult[];
  skipped: { id: string; reason: string }[];
}

/** Run every available probe once, store each response shape, and report which ones changed. */
export async function runOnce(opts: RunOptions): Promise<RunReport> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => new Date());
  const secret = env.SHAPI_SHAPE_SECRET ?? DEV_SECRET;
  const results: ProbeResult[] = [];
  const skipped: RunReport["skipped"] = [];

  for (const worker of opts.workers ?? WORKERS) {
    if (opts.providers && !opts.providers.includes(worker.provider)) continue;
    const plan = worker.probes(env);
    skipped.push(...plan.skipped);
    for (const probe of plan.probes) {
      results.push(await runProbe(probe, opts.store, doFetch, now, secret, opts.timeoutMs ?? 15_000));
    }
  }
  return { results, skipped };
}

async function runProbe(
  probe: Probe,
  store: ShapeStore,
  doFetch: typeof globalThis.fetch,
  now: () => Date,
  secret: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const base = { id: probe.id, provider: probe.provider, method: probe.method, endpoint: probe.endpoint, changed: false };
  const started = performance.now();
  try {
    const res = await doFetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    const shape = inferShape({ status: res.status, headers: res.headers, body }, { salt: providerSalt(probe.provider, secret) });
    const source = probeSource(probe);
    const previous = store.latest(probe.provider, probe.method, probe.endpoint, source);
    const stored = store.record({
      provider: probe.provider,
      method: probe.method,
      endpoint: probe.endpoint,
      observedAt: now().toISOString(),
      source,
      shape,
    });
    const changed = previous !== undefined && previous.shapeHash !== stored.shapeHash;
    const diff = changed ? diffShapes(previous.shape, stored.shape) : undefined;
    const draft = changed && diff ? draftAdvisory({ before: previous, after: stored, diff }) : undefined;
    return {
      ...base,
      status: res.status,
      shapeHash: stored.shapeHash,
      changed,
      previousHash: previous?.shapeHash,
      ...(diff ? { diff } : {}),
      ...(draft ? { draft } : {}),
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - started) };
  }
}

/** Run probes every `intervalMs` (never overlapping). Returns a stop function. */
export function runEvery(intervalMs: number, opts: RunOptions, onReport: (r: RunReport) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    onReport(await runOnce(opts));
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
