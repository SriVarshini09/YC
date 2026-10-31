import type { Advisory } from "./advisory";

/**
 * Provenance checks (execution plan C-02): every verified advisory carries the provider's exact words, a hash of the
 * page they were read from and the fetch date, and each quote can be found in the text snapshot SHAPI kept of that
 * page (advisories/evidence/snapshots/<sourceSha256>.txt). CI runs this over the whole database.
 */

// Built from code points: the characters themselves are invisible or look like their ASCII forms in source.
const chars = (...codes: number[]) => new RegExp(`[${String.fromCharCode(...codes)}]`, "g");
const SINGLE_QUOTES = chars(0x2018, 0x2019, 0x201b, 0x2032);
const DOUBLE_QUOTES = chars(0x201c, 0x201d, 0x201f, 0x2033);
const DASHES = chars(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212);
const SPACES = chars(0x00a0, 0x202f, 0x2009);

/** Page text for comparison: entities decoded, quotes and dashes folded, whitespace collapsed. */
export function normalizeText(text: string): string {
  return text
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(SPACES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "..." };

/** Whitespace collapsed within lines, blank lines dropped: what a snapshot file holds. */
function lines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** The readable text of an HTML page (scripts, styles and tags removed, one block per line), or the body as it is when it is not HTML. */
export function pageText(body: string): string {
  if (!/<(html|body|p|div)[\s>]/i.test(body)) return lines(body.replace(/\r\n?/g, "\n"));
  const text = body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(br|p|div|li|h[1-6]|tr|td|th|section|article|ul|ol|table|header|footer|main|nav|pre|blockquote|dt|dd|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return lines(text);
}

/**
 * What a snapshot keeps of a page: each quote's lines with one line of context either side, windows apart joined by
 * "\n...\n". Only enough of the provider's page to check the quote, not a copy of it.
 */
export function snapshotExcerpt(text: string, quotes: string[]): string | undefined {
  const lines = text.split("\n");
  const norm = lines.map(normalizeText);
  const keep = new Set<number>();
  /** Lines a quote is on, kept whole; context lines are cut to 200 characters. */
  const quoted = new Set<number>();
  for (const quote of quotes) {
    const q = normalizeText(quote);
    let found = false;
    for (let i = 0; i < lines.length && !found; i++) {
      let joined = norm[i]!;
      for (let j = i; j < Math.min(lines.length, i + 12); j++) {
        if (j > i) joined += ` ${norm[j]}`;
        if (!joined.includes(q)) continue;
        // The shortest window that holds the quote: drop leading lines it doesn't need.
        let start = i;
        while (start < j && normalizeText(lines.slice(start + 1, j + 1).join(" ")).includes(q)) start++;
        for (let k = start; k <= j; k++) quoted.add(k);
        for (let k = Math.max(0, start - 1); k <= Math.min(lines.length - 1, j + 1); k++) keep.add(k);
        found = true;
        break;
      }
    }
    if (!found) return undefined;
  }
  const out: string[] = [];
  let last = -2;
  for (const k of [...keep].sort((a, b) => a - b)) {
    if (k !== last + 1 && out.length) out.push("...");
    out.push(quoted.has(k) ? lines[k]! : lines[k]!.slice(0, 200));
    last = k;
  }
  return out.join("\n");
}

/** What is wrong with an advisory's provenance; empty when it is complete. `snapshot` returns a page's saved text by hash. */
export function provenanceProblems(advisory: Advisory, snapshot: (sha256: string) => string | undefined): string[] {
  const problems: string[] = [];
  const entries = advisory.provenance ?? [];
  if (advisory.status === "verified" && entries.length === 0) problems.push(`${advisory.id}: verified, but has no provenance (a source fetched with the quote that backs it)`);
  for (const p of entries) {
    const archived = /^https:\/\/web\.archive\.org\/web\/\d+(id_)?\/(.+)$/.exec(p.url)?.[2];
    // A source, the provider's published notice, or a Wayback capture of either.
    const allowed = [...advisory.sources, ...(advisory.publishedNotice ? [advisory.publishedNotice.url] : [])];
    if (!allowed.includes(p.url) && !(archived && allowed.includes(archived))) problems.push(`${advisory.id}: provenance ${p.url} is not one of its sources`);
    const text = snapshot(p.sourceSha256);
    if (text === undefined) {
      problems.push(`${advisory.id}: no snapshot for ${p.url} (${p.sourceSha256})`);
      continue;
    }
    if (!normalizeText(text).includes(normalizeText(p.quote))) problems.push(`${advisory.id}: the quote from ${p.url} is not in its snapshot: "${p.quote.slice(0, 80)}"`);
  }
  return problems;
}
