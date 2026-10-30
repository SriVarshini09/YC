/**
 * Wayback Machine captures of advisory sources (execution plan P-13): for each source URL, the Internet Archive's
 * earliest successful capture, so an advisory's evidence survives the provider editing or deleting its page. Reads the
 * public CDX API only; it never asks the archive to save a page.
 */

export interface Capture {
  url: string;
  /** ISO time of the earliest capture that answered 200; null when the archive has none. */
  firstCaptured: string | null;
  /** The capture itself, on web.archive.org. */
  captureUrl?: string;
  /** Why there is no capture: none in the archive, or the lookup failed. */
  note?: string;
}

export interface WaybackOptions {
  fetch?: typeof fetch;
  /** Wait between retries, in ms (tests pass 0). */
  retryDelayMs?: number;
}

/** The CDX query for a URL's earliest capture that answered 200. */
export function cdxUrl(url: string): string {
  const q = new URLSearchParams({ url, output: "json", limit: "1", fl: "timestamp,original,statuscode", filter: "statuscode:200" });
  return `https://web.archive.org/cdx/search/cdx?${q}`;
}

/** `20220421100952` → `2022-04-21T10:09:52Z`. */
export function waybackTime(timestamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp);
  if (!m) throw new Error(`not a Wayback timestamp: ${timestamp}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/** A CDX JSON answer: a header row, then one row per capture. */
export function parseCdx(url: string, rows: unknown): Capture {
  const first = Array.isArray(rows) ? (rows[1] as unknown[] | undefined) : undefined;
  if (!first) return { url, firstCaptured: null, note: "no capture in the Wayback Machine" };
  const [timestamp, original] = first as [string, string];
  return { url, firstCaptured: waybackTime(timestamp), captureUrl: `https://web.archive.org/web/${timestamp}/${original}` };
}

/** The earliest capture of a URL, retried on 429 and 5xx; a lookup that keeps failing is recorded with why. */
export async function firstCapture(url: string, opts: WaybackOptions = {}): Promise<Capture> {
  const doFetch = opts.fetch ?? fetch;
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await doFetch(cdxUrl(url), { headers: { "user-agent": "shapi-bench (https://shapi.dev)" } });
      if (res.ok) {
        const text = await res.text();
        return parseCdx(url, text.trim() ? JSON.parse(text) : []);
      }
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 5000) * (attempt + 1)));
  }
  return { url, firstCaptured: null, note: `lookup failed (${last}); run again` };
}
