import type { Advisory } from "@shapi/core";
import { diffShapes, inferShape, providerSalt, toWitness, type ShapeDiff, type ShapeRepository, type Witness } from "@shapi/shapes";
import { draftAdvisory } from "./draft";
import { probeSource, type Env, type Probe, type Worker } from "./probe";
import { githubWorker } from "./workers/github";
import { anthropicWorker, hubspotWorker, openaiWorker, slackWorker, twilioWorker } from "./workers/more";
import { stripeWorker } from "./workers/stripe";

export const WORKERS: Worker[] = [githubWorker, stripeWorker, slackWorker, openaiWorker, anthropicWorker, twilioWorker, hubspotWorker];

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
  /** The response as a shape witness (A-01): value-free, every key recorded (SHAPI's own test accounts). */
  witness?: Witness;
  /** The shape differs from the previous observation of this endpoint: a candidate change, not yet drafted. */
  changed: boolean;
  /**
   * The change seen in the previous cycle held in this one too (CN-03): it is confirmed, and drafted when breaking.
   * A probe that answers differently once and then goes back never confirms, so a single flaky response drafts nothing.
   */
  confirmed?: boolean;
  /** Hash of the previous observation, when there was one. */
  previousHash?: string;
  /** What changed: this cycle's candidate change, or the change this cycle confirmed. */
  diff?: ShapeDiff;
  /** Draft advisory, when a confirmed change is breaking. */
  draft?: Advisory;
  error?: string;
  ms: number;
}

export interface RunOptions {
  /** Where shapes are stored: the local SQLite store, or the hosted Postgres store. */
  store: ShapeRepository;
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
    let plan: ReturnType<Worker["probes"]>;
    try {
      plan = worker.probes(env);
    } catch (err) {
      // A misconfigured credential fails its own provider, not every provider after it.
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: `${worker.provider}:config`, provider: worker.provider, method: "", endpoint: "", changed: false, error: `configuration: ${message}`, ms: 0 });
      continue;
    }
    skipped.push(...plan.skipped);
    for (const probe of plan.probes) {
      results.push(await runProbe(probe, opts.store, doFetch, now, secret, opts.timeoutMs ?? 15_000));
    }
  }
  return { results, skipped };
}

async function runProbe(
  probe: Probe,
  store: ShapeRepository,
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
    // Not an observation of the API's shape: recording it would draft a breaking "auth" change.
    const refused = refusal(probe, res);
    if (refused) return { ...base, status: res.status, error: refused, ms: Math.round(performance.now() - started) };
    const shape = inferShape({ status: res.status, headers: res.headers, body }, { salt: providerSalt(probe.provider, secret) });
    const source = probeSource(probe);
    const observedAt = now().toISOString();
    const witness = toWitness(
      { status: res.status, headers: res.headers, body },
      { provider: probe.provider, method: probe.method, pathTemplate: probe.endpoint, source: "canary", observedAt, allow: { keys: "*" } },
    );
    const previous = await store.latest(probe.provider, probe.method, probe.endpoint, source);
    const stored = await store.record({
      provider: probe.provider,
      method: probe.method,
      endpoint: probe.endpoint,
      observedAt,
      source,
      shape,
    });
    const changed = previous !== undefined && previous.shapeHash !== stored.shapeHash;
    // CN-03: the shape before last differs, and the last one matches this one: the change has held for two cycles.
    const [, last, before] = await store.history(probe.provider, probe.method, probe.endpoint, { limit: 3, source });
    const confirmed = !changed && last !== undefined && before !== undefined && last.shapeHash === stored.shapeHash && before.shapeHash !== stored.shapeHash;
    const diff = changed ? diffShapes(previous.shape, stored.shape) : confirmed ? diffShapes(before.shape, stored.shape) : undefined;
    const draft = confirmed && diff ? draftAdvisory({ before, after: stored, diff }) : undefined;
    return {
      ...base,
      status: res.status,
      shapeHash: stored.shapeHash,
      witness,
      changed,
      ...(confirmed ? { confirmed } : {}),
      previousHash: previous?.shapeHash,
      ...(diff ? { diff } : {}),
      ...(draft ? { draft } : {}),
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - started) };
  }
}

/**
 * Why a response is not an observation of the endpoint, or undefined when it is: a rate limit (GitHub
 * answers 403 with x-ratelimit-remaining: 0), or SHAPI's own credential being rejected.
 */
function refusal(probe: Probe, res: Response): string | undefined {
  const limited = res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
  if (limited) return `rate limited (HTTP ${res.status}); nothing recorded`;
  if (probe.auth === "token" && res.status === 401) return "credentials rejected (HTTP 401): check this provider's key; nothing recorded";
  return undefined;
}

/**
 * Run probes every `intervalMs` (never overlapping). A failed run is passed to `onError` and the
 * schedule goes on. Returns a stop function, which resolves once a run in progress has finished.
 */
export function runEvery(intervalMs: number, opts: RunOptions, onReport: (r: RunReport) => void, onError: (err: unknown) => void = () => {}): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = (async () => {
      try {
        onReport(await runOnce(opts));
      } catch (err) {
        onError(err);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
