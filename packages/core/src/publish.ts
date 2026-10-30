import { getProvider } from "./providers";
import type { Advisory } from "./advisory";

/**
 * The advisory database as plain files for people, tools and language models (execution plan G-04): a Markdown twin
 * of each advisory page, one JSON file per provider, an iCalendar feed of effective dates, and llms.txt. All of it is
 * generated from the advisories, so it is never out of date with them.
 */
export const SITE_URL = "https://shapi.dev";

const providerName = (id: string) => getProvider(id)?.name ?? id;
const count = (n: number) => `${n} ${n === 1 ? "advisory" : "advisories"}`;
export const advisoryPageUrl = (id: string) => `${SITE_URL}/advisories/${id}`;

/** One advisory as Markdown: what changed, for which calls, from when, and what to do. */
export function advisoryMarkdown(a: Advisory): string {
  const lines = [
    `# ${a.title}`,
    "",
    `- **Provider:** ${providerName(a.provider)}`,
    `- **Endpoint:** \`${a.endpoint.method} ${a.endpoint.path}\`${a.endpoint.hosts?.length ? ` on ${a.endpoint.hosts.map((h) => `\`${h}\``).join(", ")}` : ""}`,
    `- **Effective:** ${a.effectiveDate}`,
    `- **Severity:** ${a.severity}`,
    `- **Change:** ${a.changeClass}`,
    `- **Status:** ${a.status}${a.status === "unverified" ? " (secondary reports only; SHAPI does not open fix PRs for it)" : ""}`,
    ...(a.recipeId ? [`- **Automatic fix:** \`${a.recipeId}\``] : []),
    "",
    "## What changed",
    "",
    a.summary,
    "",
    "## What to do",
    "",
    a.migrationNote,
    "",
    "## Sources",
    "",
    ...(a.publishedNotice ? [`- Provider notice${a.publishedNotice.date ? ` (${a.publishedNotice.date})` : ""}: ${a.publishedNotice.url}`] : []),
    ...a.sources.filter((s) => s !== a.publishedNotice?.url).map((s) => `- ${s}`),
    "",
    "## Machine-readable",
    "",
    `- Advisory: https://github.com/SriVarshini09/shapi-advisories/blob/main/advisories/${a.id}.json`,
    `- OSV: ${SITE_URL}/osv/${a.id}.json`,
    "",
  ];
  return lines.join("\n");
}

/** Every advisory for one provider, soonest effective date first. */
export function providerJson(provider: string, advisories: Advisory[]): Record<string, unknown> {
  const mine = advisories.filter((a) => a.provider === provider).sort((x, y) => x.effectiveDate.localeCompare(y.effectiveDate) || x.id.localeCompare(y.id));
  return {
    provider,
    name: providerName(provider),
    count: mine.length,
    advisories: mine.map((a) => ({
      id: a.id,
      title: a.title,
      endpoint: a.endpoint,
      changeClass: a.changeClass,
      effectiveDate: a.effectiveDate,
      severity: a.severity,
      status: a.status,
      fix: a.recipeId ?? null,
      url: advisoryPageUrl(a.id),
      markdown: `${advisoryPageUrl(a.id)}.md`,
      osv: `${SITE_URL}/osv/${a.id}.json`,
    })),
  };
}

/** iCalendar text: escaped, and folded at 75 octets as RFC 5545 asks. */
function icsLine(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** One all-day event per advisory on its effective date. DTSTAMP is the effective date too, so the feed is stable. */
export function deadlinesIcs(advisories: Advisory[]): string {
  const day = (d: string) => d.replaceAll("-", "");
  const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const events = [...advisories]
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id))
    .flatMap((a) => [
      "BEGIN:VEVENT",
      `UID:${a.id}@shapi.dev`,
      `DTSTAMP:${day(a.effectiveDate)}T000000Z`,
      `DTSTART;VALUE=DATE:${day(a.effectiveDate)}`,
      `DTEND;VALUE=DATE:${day(next(a.effectiveDate))}`,
      `SUMMARY:${icsText(`${providerName(a.provider)}: ${a.title}`)}`,
      `DESCRIPTION:${icsText(`${a.summary}\n\nWhat to do: ${a.migrationNote}`)}`,
      `URL:${advisoryPageUrl(a.id)}`,
      "END:VEVENT",
    ]);
  return [...["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SHAPI//API change deadlines//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:SHAPI API change deadlines"], ...events, "END:VCALENDAR"].map(icsLine).join("\r\n") + "\r\n";
}

/** llms.txt (llmstxt.org): what SHAPI is, its docs, and every advisory's Markdown twin. */
export function llmsTxt(advisories: Advisory[], docs: { title: string; path: string; description: string }[]): string {
  const providers = [...new Set(advisories.map((a) => a.provider))].sort();
  return [
    "# SHAPI",
    "",
    "> SHAPI finds the code that breaks when a third-party API changes (a renamed field, a new status code, a retired version or model), and fixes it test-first: it writes a contract test that fails before the fix and passes after, and opens a pull request.",
    "",
    "Advisories are open data (CC BY 4.0). Each lists the endpoint, what changed, the effective date, and what to do.",
    "",
    "## Docs",
    "",
    ...docs.map((d) => `- [${d.title}](${SITE_URL}${d.path}): ${d.description}`),
    "",
    "## Advisories by provider",
    "",
    ...providers.map((p) => `- [${providerName(p)}](${SITE_URL}/api/v1/providers/${p}.json): ${count(advisories.filter((a) => a.provider === p).length)}, as JSON`),
    `- [All effective dates](${SITE_URL}/deadlines.ics): iCalendar`,
    "",
    "## Advisories",
    "",
    ...[...advisories].sort((a, b) => a.id.localeCompare(b.id)).map((a) => `- [${a.title}](${advisoryPageUrl(a.id)}.md): ${providerName(a.provider)}, effective ${a.effectiveDate}, ${a.status}`),
    "",
  ].join("\n");
}
