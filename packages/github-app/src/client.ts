import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";

/**
 * Octokit with GitHub's rate-limit rules built in: requests are queued so writes stay at least a
 * second apart (GitHub's guidance for creating content), rate-limited requests wait and retry
 * when the wait is short, and 5xx answers are retried.
 */
const ResilientOctokit = Octokit.plugin(throttling, retry);

export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Throttling and retries (default on). Tests against a fake GitHub turn it off for speed. */
  resilient?: boolean;
}

type OctokitOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>;

/** Wait out a rate limit up to this long; longer waits fail the request so the job retries later. */
const MAX_WAIT_SECONDS = 60;

export function createOctokit(options: OctokitOptions, opts: ClientOptions = {}): Octokit {
  const base: OctokitOptions = { userAgent: "shapi", ...options, request: opts.fetch ? { fetch: opts.fetch } : undefined };
  if (opts.resilient === false) return new Octokit(base);
  return new ResilientOctokit({
    ...base,
    throttle: {
      onRateLimit: (retryAfter, _options, _octokit, retryCount) => retryCount < 2 && retryAfter <= MAX_WAIT_SECONDS,
      onSecondaryRateLimit: (retryAfter, _options, _octokit, retryCount) => retryCount < 2 && retryAfter <= MAX_WAIT_SECONDS * 2,
    },
    retry: { retries: 2 },
  });
}
