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
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

/**
 * Outgoing requests are recorded as breadcrumbs with their URL. A Slack incoming webhook's URL is the
 * customer's secret, so those are dropped; other requests lose their query string (signed download links).
 */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  const data = breadcrumb.data as Record<string, unknown> | undefined;
  const url = typeof data?.url === "string" ? data.url : "";
  if (/hooks\.slack\.com/i.test(`${url} ${breadcrumb.message ?? ""}`)) return null;
  if (!data) return breadcrumb;
  const rest = { ...data };
  delete rest["http.query"];
  delete rest["http.fragment"];
  if (url) rest.url = url.split(/[?#]/)[0];
  return { ...breadcrumb, data: rest };
}

export function reportError(err: unknown): void {
  Sentry.captureException(err);
}

export async function flushErrors(): Promise<void> {
  await Sentry.flush(2000);
}
