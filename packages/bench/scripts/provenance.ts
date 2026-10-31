/**
 * Fetch every source of the verified advisories and record its provenance (execution plan C-02): the sentence on the
 * page that backs the advisory, word for word, the SHA-256 of the page as fetched and the fetch time. Each page's
 * snapshot, advisories/evidence/snapshots/<sha256>.txt, keeps the lines its quotes are on with a line of context
 * (not the page), so CI can check every quote against it. A page that can't be fetched (or renders nothing without
 * JavaScript) is read from its Wayback capture instead, under the capture's URL.
 *
 * The quote is picked automatically: the sentence that says something changes and shares the most rare words with
 * the advisory. Where that picks the wrong sentence (a page whose dates sit in table cells, say), a reviewed pattern
 * in advisories/evidence/quote-hints.json says what to quote, over up to `lines` lines read together.
 * Advisories that already have provenance are left as they are; `--redo` fetches the named ones again.
 *
 *   pnpm --filter @shapi/bench bench:provenance                   (verified advisories without provenance)
 *   pnpm --filter @shapi/bench bench:provenance -- --redo <id>…   (these, again)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, pageText, snapshotExcerpt, type Advisory, type Provenance } from "@shapi/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const dir = path.join(repoRoot, "advisories");
const snapshots = path.join(dir, "evidence", "snapshots");
const captures = JSON.parse(readFileSync(path.join(dir, "evidence", "captures.json"), "utf8")) as {
  advisories: Record<string, { sources: { url: string; captureUrl?: string }[] }>;
};
const hints = JSON.parse(readFileSync(path.join(dir, "evidence", "quote-hints.json"), "utf8")) as Record<string, { pattern: string; lines?: number } | string>;
const args = process.argv.slice(2).filter((a) => a !== "--");
const redo = args.includes("--redo");
const only = new Set(args.filter((a) => !a.startsWith("--")));
mkdirSync(snapshots, { recursive: true });

const UA = "Mozilla/5.0 (compatible; SHAPI-provenance/1.0; +https://shapi.dev/advisories)";

async function get(url: string): Promise<{ body: string; sha: string } | undefined> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,*/*", "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(30_000), redirect: "follow" });
    if (!res.ok) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    return { body: bytes.toString("utf8"), sha: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return undefined;
  }
}

const STOP = new Set("the a an and or of to in on for with is are be by as at from that this it its will was were has have not no can you your their they we our than then when which who what into via per any all after before more also only use used using".split(" "));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9_.\-/{}]+/g)?.map((w) => w.replace(/^[.\-/]+|[.\-/]+$/g, "")).filter((w) => w.length > 2 && !STOP.has(w)) ?? [];

/** Terms that say what the advisory is about, weighted: the endpoint and trigger values count most. */
function terms(a: Advisory): Map<string, number> {
  const t = new Map<string, number>();
  const add = (s: string | undefined, w: number) => {
    for (const x of words(s ?? "")) t.set(x, Math.max(t.get(x) ?? 0, w));
  };
  add(a.title, 2);
  add(a.summary, 1);
  add(a.migrationNote, 1);
  for (const seg of a.endpoint.path?.split("/") ?? []) if (seg && !seg.startsWith("{")) add(seg, 3);
  add(JSON.stringify(a.trigger).replace(/[{}":,[\]]/g, " "), 3);
  const d = new Date(`${a.effectiveDate}T00:00:00Z`);
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  t.set(month, 2);
  t.set(String(d.getUTCFullYear()), 1);
  t.set(a.effectiveDate, 3);
  return t;
}

/** A sentence that says something changes: a quote has to back a change, not name the page. */
const CHANGE = /\b(remov|deprecat|retir|sunset|shut|turn(ed|s)? off|no longer|stop|replac|requir|reject|chang|discontinu|end of life|unsupported|decommission|return|will|default|migrat|instead|fail|error|disabl|expir|ignor)/i;
/** Quotes this strong stand on their own; weaker ones are kept only when an advisory has nothing better. */
const STRONG = 4.5;

/** The sentence on the page that best backs the advisory, exactly as the page has it. */
function bestQuote(text: string, a: Advisory): { quote: string; score: number } | undefined {
  const hint = hints[a.id];
  const lines = text.split("\n");
  if (hint) {
    // A reviewed pattern: the first run of up to `lines` lines that matches it, read as one.
    const { pattern, lines: n = 1 } = typeof hint === "string" ? { pattern: hint } : hint;
    const re = new RegExp(pattern, "i");
    for (let i = 0; i < lines.length; i++) {
      for (let k = 1; k <= n && i + k <= lines.length; k++) {
        const quote = lines.slice(i, i + k).map(normalizeText).join(" ");
        if (quote.length <= 400 && re.test(quote)) return { quote, score: STRONG };
      }
    }
    return undefined;
  }
  const t = terms(a);
  const sentences = lines
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9`"(])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400 && s.split(" ").length >= 7 && CHANGE.test(s));
  // Rare words on this page say more than common ones.
  const df = new Map<string, number>();
  for (const s of sentences) for (const w of new Set(words(s))) df.set(w, (df.get(w) ?? 0) + 1);
  let best: { quote: string; score: number } | undefined;
  for (const s of sentences) {
    let score = 0;
    for (const w of new Set(words(s))) {
      const weight = t.get(w);
      if (weight) score += weight / Math.sqrt(df.get(w) ?? 1);
    }
    if (!best || score > best.score) best = { quote: s, score };
  }
  return best && best.score >= 2 ? best : undefined;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const all = files.map((f) => ({ file: path.join(dir, f), raw: readFileSync(path.join(dir, f), "utf8") })).map((x) => ({ ...x, a: JSON.parse(x.raw) as Advisory }));
/** Full page text by hash, for the pages fetched in this run. */
const pages = new Map<string, string>();
let added = 0;
const misses: string[] = [];
for (const x of all) {
  const a = x.a;
  if (a.status !== "verified" || (only.size && !only.has(a.id))) continue;
  if (a.provenance?.length && !redo) continue;
  const found: { p: Provenance; score: number }[] = [];
  // The sources, and the provider's own notice when it isn't one of them.
  for (const url of [...new Set([...a.sources, ...(a.publishedNotice ? [a.publishedNotice.url] : [])])]) {
    const capture = captures.advisories[a.id]?.sources.find((s) => s.url === url)?.captureUrl;
    const candidates = [url, ...(capture ? [capture.replace(/\/web\/(\d+)\//, "/web/$1id_/")] : [])];
    for (const from of candidates) {
      const page = await get(from);
      const text = page ? pageText(page.body) : "";
      const pick = page && text.length > 200 ? bestQuote(text, a) : undefined;
      if (!page || !pick) continue;
      pages.set(page.sha, text);
      found.push({ p: { url: from, quote: pick.quote, sourceSha256: page.sha, fetchedAt: new Date().toISOString() }, score: pick.score });
      console.log(`${a.id}  ${from}\n    "${pick.quote}"  (${pick.score.toFixed(1)})`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // The strong quotes, or the best one when none is strong.
  const strong = found.filter((f) => f.score >= STRONG);
  const kept = strong.length ? strong : [...found].sort((p, q) => q.score - p.score).slice(0, 1);
  if (!kept.length) {
    misses.push(a.id);
    console.log(`${a.id}  no source gave a quote`);
    continue;
  }
  a.provenance = kept.map((f) => f.p);
  writeFileSync(x.file, withProvenance(x.raw, a.provenance));
  added++;
}

/** The advisory file with its provenance last, as in the schema, and every other line as it was. */
function withProvenance(raw: string, provenance: Provenance[]): string {
  const cut = raw.indexOf(',\n  "provenance": ');
  const body = (cut >= 0 ? raw.slice(0, cut) : raw.trimEnd().replace(/\n\}$/, "")).trimEnd();
  return `${body},\n  "provenance": ${JSON.stringify(provenance, null, 2).replace(/\n/g, "\n  ")}\n}\n`;
}

// Every snapshot holds the lines its quotes are on: from the page fetched now, or from the snapshot as it is.
const quotesBySha = new Map<string, string[]>();
for (const { a } of all) for (const p of a.provenance ?? []) quotesBySha.set(p.sourceSha256, [...(quotesBySha.get(p.sourceSha256) ?? []), p.quote]);
for (const [sha, quotes] of quotesBySha) {
  const file = path.join(snapshots, `${sha}.txt`);
  const text = pages.get(sha) ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const excerpt = text ? snapshotExcerpt(text, quotes) : undefined;
  if (excerpt) writeFileSync(file, excerpt + "\n");
  else console.log(`snapshot ${sha}: a quote is not in it`);
}
console.log(`\n${added} advisories given provenance${misses.length ? `; none for: ${misses.join(", ")}` : ""}`);
