import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Page watchers (execution plan C-01): fetch the provider pages advisories come from (changelogs, deprecation pages)
 * and compare each with its committed snapshot. A page that changed becomes a draft for a person to read; a page that
 * can't be trusted (an error status, a redirect, too small or too large, a missing marker, a sudden shrink) becomes one
 * issue for its source and never a draft, so a 404 or a login wall is not mistaken for the provider deleting its notes.
 */
export const WatchSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  provider: z.string(),
  url: z.url(),
  /** Text the page must contain, or it isn't the page we think it is (a login wall, an error page). */
  markers: z.array(z.string().min(1)).min(1),
  minBytes: z.number().int().positive().default(2_000),
  maxBytes: z.number().int().positive().default(5_000_000),
});
export type WatchSource = z.infer<typeof WatchSourceSchema>;

export type WatchOutcome = "first" | "unchanged" | "changed" | "failed";

export interface WatchResult {
  id: string;
  url: string;
  outcome: WatchOutcome;
  /** Why the page was rejected, for `failed`. */
  reason?: string;
  added?: string[];
  removed?: string[];
}

/** A page's visible text, one line per block, so a re-render with the same words compares equal. */
export function pageText(body: string): string {
  return body
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(p|div|li|tr|h[1-6]|br|section|article|table|ul|ol|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Pages that lose more than this share of their text at once are rejected: a provider rarely deletes 40% of a changelog. */
export const MAX_SHRINK = 0.4;

/** Fetch one source through the guards and compare it with its snapshot. `text` is set when the page passed. */
export async function checkSource(src: WatchSource, snapshot: string | undefined, opts: { fetch?: typeof fetch } = {}): Promise<{ result: WatchResult; text?: string }> {
  const fail = (reason: string) => ({ result: { id: src.id, url: src.url, outcome: "failed" as const, reason } });
  let res: Response;
  try {
    // No redirects: a moved page, a login redirect or a consent wall is a reason to look, not new content.
    res = await (opts.fetch ?? fetch)(src.url, { redirect: "manual", headers: { "user-agent": "shapi-watch (https://shapi.dev)" } });
  } catch (err) {
    return fail(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 300 && res.status < 400) return fail(`redirected (${res.status}) to ${res.headers.get("location") ?? "an unknown location"}`);
  if (res.status !== 200) return fail(`HTTP ${res.status}`);
  const body = await res.text();
  const bytes = Buffer.byteLength(body);
  if (bytes < src.minBytes) return fail(`${bytes} bytes, under the ${src.minBytes}-byte minimum`);
  if (bytes > src.maxBytes) return fail(`${bytes} bytes, over the ${src.maxBytes}-byte maximum`);
  const missing = src.markers.filter((m) => !body.includes(m));
  if (missing.length) return fail(`missing marker${missing.length > 1 ? "s" : ""} ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  const text = pageText(body);
  if (snapshot === undefined) return { result: { id: src.id, url: src.url, outcome: "first" }, text };
  if (text.length < snapshot.length * (1 - MAX_SHRINK)) {
    return fail(`shrank by ${Math.round((1 - text.length / snapshot.length) * 100)}% since the snapshot (more than ${MAX_SHRINK * 100}%)`);
  }
  if (text === snapshot) return { result: { id: src.id, url: src.url, outcome: "unchanged" }, text };
  const before = new Set(snapshot.split("\n"));
  const after = new Set(text.split("\n"));
  return {
    result: { id: src.id, url: src.url, outcome: "changed", added: [...after].filter((l) => !before.has(l)), removed: [...before].filter((l) => !after.has(l)) },
    text,
  };
}

/** What a watcher run asks a person to look at: one issue per failing source, one draft per changed page. */
export interface WatchIssue {
  source: string;
  title: string;
  body: string;
}

export interface WatchRun {
  results: WatchResult[];
  issues: WatchIssue[];
  /** Draft files written, one per changed page. */
  drafts: string[];
}

/**
 * Check every source. Snapshots are updated only for pages that passed the guards; a changed page also gets a draft
 * (`<drafts>/<id>-<date>.md`) listing what was added and removed; a failed one gets an issue and keeps its snapshot.
 */
export async function runWatch(sources: WatchSource[], dirs: { snapshots: string; drafts: string }, opts: { fetch?: typeof fetch; now?: Date } = {}): Promise<WatchRun> {
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const run: WatchRun = { results: [], issues: [], drafts: [] };
  mkdirSync(dirs.snapshots, { recursive: true });
  for (const src of sources) {
    const file = path.join(dirs.snapshots, `${src.id}.txt`);
    const snapshot = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const { result, text } = await checkSource(src, snapshot, opts);
    run.results.push(result);
    if (result.outcome === "failed") {
      // One issue per source per run, however many guards it failed.
      run.issues.push({
        source: src.id,
        title: `Watcher: ${src.id} could not be checked`,
        body: `${src.url} failed a fetch guard on ${day}: ${result.reason}.\n\nNo draft was written and the snapshot was kept. Check the page by hand; if it moved, update its URL or markers in the watch sources.`,
      });
      continue;
    }
    if (text !== undefined) writeFileSync(file, text);
    if (result.outcome === "changed") {
      mkdirSync(dirs.drafts, { recursive: true });
      const draft = path.join(dirs.drafts, `${src.id}-${day.replaceAll("-", "")}.md`);
      const list = (lines: string[] | undefined) => (lines?.length ? lines.map((l) => `- ${l}`).join("\n") : "- (none)");
      writeFileSync(
        draft,
        `# ${src.provider}: ${src.id} changed on ${day}\n\nSource: ${src.url}\n\nUnverified: a page watcher saw this change. Read it, and write or update an advisory if it announces a change to the API.\n\n## Added\n\n${list(result.added)}\n\n## Removed\n\n${list(result.removed)}\n`,
      );
      run.drafts.push(draft);
    }
  }
  return run;
}
