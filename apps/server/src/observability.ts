import * as Sentry from "@sentry/node";
import type { Config } from "./config";

/** Error reporting to Sentry when SENTRY_DSN is set; a no-op otherwise. */
export function initErrorReporting(config: Pick<Config, "SENTRY_DSN" | "NODE_ENV" | "GIT_SHA">, process_: string): void {
  if (!config.SENTRY_DSN) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    release: config.GIT_SHA,
    serverName: process_,
    tracesSampleRate: 0,
    // Never send request data (bodies, headers, cookies): it can hold customer code or tokens.
    beforeSend(event) {
      delete event.request;
      delete event.user;
      return event;
    },
  });
}

export function reportError(err: unknown): void {
  Sentry.captureException(err);
}

export async function flushErrors(): Promise<void> {
  await Sentry.flush(2000);
}
