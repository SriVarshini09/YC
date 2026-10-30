import type { Advisory } from "./advisory";
import type { MatchResult } from "./matcher";

/**
 * Standard exports (execution plan S-03): each advisory in the OSV format, and a scan's verdicts as an OpenVEX
 * document, so vulnerability tooling can read SHAPI's data alongside CVEs.
 *
 * OSV is built for package releases; an API change has no package or version range. So an advisory is an OSV
 * record with SHAPI's own ID prefix (`x_`, OSV's prefix for databases it doesn't list), no `package`, and the API
 * details (provider, endpoint, change class, trigger) in `affected[].ecosystem_specific`.
 */
export const OSV_SCHEMA_VERSION = "1.7.0";
export const OSV_BASE_URL = "https://shapi.dev/osv";

export const osvId = (advisoryId: string) => `x_SHAPI-${advisoryId}`;

const day = (date: string) => `${date}T00:00:00Z`;

function lastRecorded(a: Advisory): string {
  const days = [a.effectiveDate, a.publishedNotice?.date, a.firstObserved].filter((d): d is string => Boolean(d)).map(day);
  const times = [...days, ...(a.provenance ?? []).map((p) => new Date(p.fetchedAt).toISOString().replace(/\.\d{3}Z$/, "Z"))];
  return times.sort().at(-1) as string;
}

/**
 * `modified` defaults to the latest date the advisory records (effective date, notice, first sighting, a source fetched),
 * so the published records only change when the advisory does.
 */
export function advisoryToOsv(a: Advisory, opts: { modified?: string } = {}): Record<string, unknown> {
  const published = a.publishedNotice?.date ?? a.firstObserved ?? a.effectiveDate;
  return {
    schema_version: OSV_SCHEMA_VERSION,
    id: osvId(a.id),
    modified: opts.modified ?? lastRecorded(a),
    published: day(published),
    summary: a.title,
    details: `${a.summary}\n\n${a.migrationNote}`,
    affected: [
      {
        ecosystem_specific: {
          provider: a.provider,
          endpoint: a.endpoint,
          change_class: a.changeClass,
          trigger: a.trigger,
          effective_date: a.effectiveDate,
          ...(a.recipeId ? { recipe: a.recipeId } : {}),
        },
      },
    ],
    references: [
      ...(a.publishedNotice ? [{ type: "ADVISORY", url: a.publishedNotice.url }] : []),
      ...a.sources.filter((s) => s !== a.publishedNotice?.url).map((url) => ({ type: "WEB", url })),
    ],
    database_specific: { severity: a.severity, status: a.status, url: `${OSV_BASE_URL}/${a.id}.json` },
  };
}

export interface VexOptions {
  /** `owner/name`. */
  repo: string;
  sha?: string;
  timestamp: string;
  toolVersion?: string;
}

/**
 * A scan's verdicts as an OpenVEX 0.2.0 document, one statement per advisory that reaches the repository:
 * - affected call sites: `affected`, with the advisory's migration note as the action;
 * - only exposed ones (the endpoint is called, but nothing depends on what changed): `not_affected`, justified as
 *   `vulnerable_code_not_present`;
 * - possibly affected or "Could not tell": `under_investigation`.
 * Each call site is a subcomponent, identified by its line on GitHub at the scanned commit. `advisories` are the ones
 * the scan matched against, to name those listed only under "Could not tell".
 */
export function matchToOpenVex(match: Pick<MatchResult, "affected" | "exposed" | "possible" | "unresolved">, advisories: Advisory[], opts: VexOptions): Record<string, unknown> {
  const ref = opts.sha ?? "HEAD";
  const product = `https://github.com/${opts.repo}${opts.sha ? `/tree/${opts.sha}` : ""}`;
  const line = (file: string, n: number) => `https://github.com/${opts.repo}/blob/${ref}/${file}#L${n}`;
  type Group = { advisory: Advisory; affected: string[]; exposed: string[]; unsure: string[] };
  const groups = new Map<string, Group>();
  const group = (a: Advisory) => groups.get(a.id) ?? (groups.set(a.id, { advisory: a, affected: [], exposed: [], unsure: [] }).get(a.id) as Group);
  for (const f of match.affected) group(f.advisory).affected.push(line(f.callSite.file, f.callSite.line));
  for (const f of match.exposed) group(f.advisory).exposed.push(line(f.callSite.file, f.callSite.line));
  for (const f of match.possible) group(f.advisory).unsure.push(line(f.callSite.file, f.callSite.line));
  const byId = new Map([...advisories, ...match.affected.map((f) => f.advisory), ...match.exposed.map((f) => f.advisory), ...match.possible.map((f) => f.advisory)].map((a) => [a.id, a]));
  for (const u of match.unresolved) {
    for (const id of u.advisories) {
      const a = byId.get(id);
      if (a) group(a).unsure.push(line(u.callSite.file, u.callSite.line));
    }
  }
  const statements = [...groups.values()]
    .sort((x, y) => x.advisory.id.localeCompare(y.advisory.id))
    .map((g) => {
      const vulnerability = { "@id": `${OSV_BASE_URL}/${g.advisory.id}.json`, name: osvId(g.advisory.id), description: g.advisory.title };
      const products = (sites: string[]) => [{ "@id": product, subcomponents: [...new Set(sites)].map((s) => ({ "@id": s })) }];
      if (g.affected.length) {
        return { vulnerability, products: products(g.affected), status: "affected", action_statement: g.advisory.migrationNote, timestamp: opts.timestamp };
      }
      if (g.unsure.length) {
        return { vulnerability, products: products(g.unsure), status: "under_investigation", status_notes: "SHAPI cannot tell from the code whether these call sites depend on what changed; check them by hand.", timestamp: opts.timestamp };
      }
      return {
        vulnerability,
        products: products(g.exposed),
        status: "not_affected",
        justification: "vulnerable_code_not_present",
        impact_statement: "These call sites call the changed endpoint but don't depend on what changed.",
        timestamp: opts.timestamp,
      };
    });
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `https://shapi.dev/vex/${opts.repo}/${ref}`,
    author: "SHAPI",
    role: "Document Creator",
    timestamp: opts.timestamp,
    version: 1,
    tooling: `shapi${opts.toolVersion ? ` ${opts.toolVersion}` : ""}`,
    statements,
  };
}
