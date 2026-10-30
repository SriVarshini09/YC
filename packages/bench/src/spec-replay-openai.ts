/**
 * Spec-history replay for OpenAI (execution plan P-10). For each entry on OpenAI's deprecations page announced since
 * openai/openai-openapi started publishing openapi.json, diff the spec just before the announcement against the current
 * one, and ask whether it shows each deprecated model or endpoint: an endpoint removed or marked `deprecated`, or a
 * model gone from the spec's enums.
 */
import type { SpecChange } from "./spec-replay";

export interface OpenAiDeprecationRow {
  /** `January 14, 2027`, as the page writes it. */
  shutdown: string;
  /** The models and endpoints the row names (`gpt-4o-2024-08-06`, `/v1/audio/translations`). */
  names: string[];
}

export interface OpenAiDeprecation {
  date: string;
  title: string;
  rows: OpenAiDeprecationRow[];
}

/** The `### <date>: <title>` sections of the deprecations page (its markdown), each with its table's rows. */
export function parseOpenAiDeprecations(markdown: string): OpenAiDeprecation[] {
  const out: OpenAiDeprecation[] = [];
  let current: OpenAiDeprecation | undefined;
  for (const line of markdown.split("\n")) {
    const head = /^### (\d{4}-\d{2}-\d{2}): (.+)$/.exec(line);
    if (head) {
      current = { date: head[1]!, title: head[2]!.replace(/`/g, "").trim(), rows: [] };
      out.push(current);
      continue;
    }
    if (/^#{1,3} /.test(line)) current = undefined;
    if (!current || !line.startsWith("|")) continue;
    // `|` inside a cell is written `\|` (`gpt-5.1` \| `gpt-5.1-2025-11-13`).
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.replace(/\\\|/g, "|").trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]!) || /shutdown date/i.test(cells[0]!)) continue;
    const names = [...cells[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    if (names.length) current.rows.push({ shutdown: cells[0]!, names });
  }
  return out;
}

/** `/v1/audio/translations` or `v1/audio/translations` → `/audio/translations`: the spec's paths sit under its `/v1` server. */
const specPath = (name: string) => (/^\/?v1\//.test(name) ? name.replace(/^\/?v1/, "") : name.startsWith("/") ? name : undefined);

/** A change shows a row's name when it removes or deprecates that endpoint, or drops that model from an enum. */
export function changeShowsName(c: SpecChange, name: string): boolean {
  const path = specPath(name);
  if (path) return (c.kind === "operation-removed" || c.kind === "operation-deprecated") && c.operation?.split(" ")[1] === path;
  return c.kind === "enum-value-removed" && (c.values ?? []).includes(name);
}

export interface OpenAiReplayScore {
  entries: number;
  rows: number;
  /** Rows whose model or endpoint the spec diff shows. */
  shown: number;
  endpointRows: number;
  endpointRowsShown: number;
  modelRows: number;
  modelRowsShown: number;
  missed: { date: string; title: string; names: string[]; reason: string }[];
}

/** `listed(name)`: whether the current spec mentions a model at all, so a miss says which of the two it is. */
export function scoreOpenAiReplay(input: { entries: { entry: OpenAiDeprecation; changes: SpecChange[] }[]; listed?: (name: string) => boolean }): OpenAiReplayScore {
  const score: OpenAiReplayScore = { entries: input.entries.length, rows: 0, shown: 0, endpointRows: 0, endpointRowsShown: 0, modelRows: 0, modelRowsShown: 0, missed: [] };
  for (const { entry, changes } of input.entries) {
    for (const row of entry.rows) {
      const endpoint = row.names.some((n) => specPath(n));
      const shown = row.names.some((n) => changes.some((c) => changeShowsName(c, n)));
      score.rows++;
      if (endpoint) score.endpointRows++;
      else score.modelRows++;
      if (shown) {
        score.shown++;
        if (endpoint) score.endpointRowsShown++;
        else score.modelRowsShown++;
      } else {
        const listed = input.listed ? row.names.some((n) => input.listed!(n)) : true;
        const reason = endpoint
          ? "the endpoint is neither removed nor marked deprecated in the spec"
          : listed
            ? "the spec still lists the model, with nothing marking it deprecated"
            : "the current spec doesn't name the model, and no enum dropped it";
        score.missed.push({ date: entry.date, title: entry.title, names: row.names, reason });
      }
    }
  }
  return score;
}
