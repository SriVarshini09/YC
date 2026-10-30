/**
 * Spec-history replay for Twilio (execution plan P-10). twilio/twilio-oai tags each release and keeps one spec per
 * product and version (`spec/json/twilio_conversations_v1.json`). For each release whose CHANGES.md section marks a
 * breaking change, the replay diffs the named products' specs at that tag against the previous one and scores the
 * changes against those lines.
 */
import type { SpecChange } from "./spec-replay";

export interface TwilioBreakingEntry {
  /** The release's version (the git tag) and date. */
  version: string;
  date: string;
  /** The product heading the line is under (`Conversations`, `Twiml`). */
  product: string;
  text: string;
  /** Field, parameter, value, schema and path names the line quotes in backticks. */
  names: string[];
}

export interface TwilioRelease {
  version: string;
  date: string;
  entries: TwilioBreakingEntry[];
}

/**
 * Every release of CHANGES.md, newest first, with its breaking lines: lines marked `**(breaking change)**`, and the
 * lines after a `- **Breaking change**:` lead-in up to the next `- ## <date>` or the end of the product's list.
 */
export function parseTwilioChanges(markdown: string): TwilioRelease[] {
  const releases: TwilioRelease[] = [];
  let release: TwilioRelease | undefined;
  let product = "";
  let block: string[] | undefined;
  const flush = () => {
    if (block?.length && release) release.entries.push(entry(release, product, block.join(" ")));
    block = undefined;
  };
  const entry = (r: TwilioRelease, p: string, text: string): TwilioBreakingEntry => ({
    version: r.version,
    date: r.date,
    product: p,
    text: text.replace(/\s*\*\*\(breaking change\)\*\*/i, "").trim(),
    names: [...new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/^<|>$/g, "")))],
  });
  for (const line of markdown.split("\n")) {
    const head = /^\[(\d{4}-\d{2}-\d{2})\] Version (\S+)/.exec(line);
    if (head) {
      flush();
      release = { version: head[2]!, date: head[1]!, entries: [] };
      releases.push(release);
      continue;
    }
    const section = /^\*\*(.+)\*\*\s*$/.exec(line);
    if (section) {
      flush();
      product = section[1]!;
      continue;
    }
    if (!release) continue;
    if (/^- \*\*Breaking change\*\*:?\s*$/i.test(line)) {
      flush();
      block = [];
      continue;
    }
    if (block) {
      if (!line.startsWith("- ") || line.startsWith("- ## ")) flush();
      else {
        block.push(line.slice(2));
        continue;
      }
    }
    if (/\(breaking change\)/i.test(line) && line.startsWith("- ")) release.entries.push(entry(release, product, line.slice(2)));
  }
  flush();
  return releases;
}

/** The spec files of a product: `Conversations` → `twilio_conversations_v1.json`, `twilio_conversations_v2.json`. */
export function twilioSpecFiles(product: string, files: string[]): string[] {
  const slug = product.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return files.filter((f) => f.startsWith(`twilio_${slug}_`) || f === `twilio_${slug}.json`);
}

/** A change matches a line that names its field, a value it lost, its schema, or a path it is on. */
export function changeMatchesTwilioEntry(c: SpecChange, e: TwilioBreakingEntry): boolean {
  const leaf = c.field?.split(".").pop();
  const path = c.operation?.split(" ")[1] ?? "";
  return e.names.some(
    (n) => n === c.field || n === leaf || n === c.schema || (c.values ?? []).includes(n) || (n.startsWith("/") && (path === n || path.startsWith(`${n}/`))),
  );
}

export interface TwilioReplayScore {
  releases: { version: string; previous: string; date: string; files: string[]; changes: number }[];
  breakingEntries: number;
  found: number;
  /** Lines about a product with no spec in twilio-oai (TwiML is XML, not a REST API). */
  outsideSpec: number;
  /** Lines that name no field, value, schema or path, so nothing can be matched to them. */
  namesNothing: number;
  missed: { version: string; product: string; text: string; reason: string }[];
  candidates: number;
  candidatesMatching: number;
}

export function scoreTwilioReplay(input: {
  releases: { version: string; previous: string; date: string; files: string[]; changes: SpecChange[]; entries: TwilioBreakingEntry[]; specFiles: string[] }[];
}): TwilioReplayScore {
  const missed: TwilioReplayScore["missed"] = [];
  let found = 0;
  let outsideSpec = 0;
  let namesNothing = 0;
  let entries = 0;
  let candidates = 0;
  let candidatesMatching = 0;
  for (const r of input.releases) {
    candidates += r.changes.length;
    candidatesMatching += r.changes.filter((c) => r.entries.some((e) => changeMatchesTwilioEntry(c, e))).length;
    for (const e of r.entries) {
      entries++;
      const inProduct = r.changes.filter((c) => twilioSpecFiles(e.product, r.files).includes(c.file ?? ""));
      if (inProduct.some((c) => changeMatchesTwilioEntry(c, e))) found++;
      else if (!twilioSpecFiles(e.product, r.specFiles).length) {
        outsideSpec++;
        missed.push({ version: e.version, product: e.product, text: e.text, reason: `twilio-oai has no spec for ${e.product}` });
      } else if (!e.names.length) {
        namesNothing++;
        missed.push({ version: e.version, product: e.product, text: e.text, reason: "the line names no field, value, schema or path" });
      } else missed.push({ version: e.version, product: e.product, text: e.text, reason: `no change in the ${e.product} specs matches ${e.names.slice(0, 4).join(", ")}` });
    }
  }
  return {
    releases: input.releases.map((r) => ({ version: r.version, previous: r.previous, date: r.date, files: r.files, changes: r.changes.length })),
    breakingEntries: entries,
    found,
    outsideSpec,
    namesNothing,
    missed,
    candidates,
    candidatesMatching,
  };
}
