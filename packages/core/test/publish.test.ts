import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { advisoryMarkdown, deadlinesIcs, llmsTxt, loadAdvisories, providerJson } from "@shapi/core";

// Execution plan G-04: the advisory database as Markdown twins, per-provider JSON, an iCalendar feed and llms.txt.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisories = loadAdvisories(path.join(repoRoot, "advisories"));
const site = path.join(repoRoot, "site");

/** The docs pages llms.txt lists: their H1 and frontmatter description. */
function docs(): { title: string; path: string; description: string }[] {
  const pages = [...readdirSync(path.join(site, "guide")).map((f) => `guide/${f}`), "faq.md", "security.md"].filter((f) => f.endsWith(".md"));
  return pages.sort().flatMap((f) => {
    const text = readFileSync(path.join(site, f), "utf8");
    const description = /^description:\s*"?(.*?)"?\s*$/m.exec(text)?.[1];
    const title = /^# (.+)$/m.exec(text)?.[1];
    return title && description ? [{ title, path: `/${f.replace(/\.md$/, "")}`, description }] : [];
  });
}

function files(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of [...new Set(advisories.map((a) => a.provider))].sort()) out.set(`api/v1/providers/${p}.json`, `${JSON.stringify(providerJson(p, advisories), null, 2)}\n`);
  out.set("deadlines.ics", deadlinesIcs(advisories));
  out.set("llms.txt", llmsTxt(advisories, docs()));
  return out;
}

describe("public advisory files (G-04)", () => {
  const generated = files();

  it("writes a Markdown twin per advisory, a JSON file per provider, the deadlines feed and llms.txt", () => {
    // The Markdown twins are written into the built site by site/scripts/advisory-twins.ts.
    expect(advisoryMarkdown(advisories[0]!)).toMatch(/^# .+\n\n- \*\*Provider:\*\* /);
    const stripe = JSON.parse(generated.get("api/v1/providers/stripe.json")!) as { count: number; advisories: { effectiveDate: string; url: string }[] };
    expect(stripe.count).toBe(advisories.filter((a) => a.provider === "stripe").length);
    expect(stripe.advisories.map((a) => a.effectiveDate)).toEqual([...stripe.advisories.map((a) => a.effectiveDate)].sort());
    expect(stripe.advisories[0]!.url).toMatch(/^https:\/\/shapi\.dev\/advisories\/stripe-/);
    const llms = generated.get("llms.txt")!;
    expect(llms).toMatch(/^# SHAPI\n\n> /);
    expect(llms).toContain("- [How fixes are verified](https://shapi.dev/guide/fixes):");
    expect(llms.split("\n").filter((l) => l.includes("/advisories/") && (l.endsWith(", verified") || l.endsWith(", unverified")))).toHaveLength(advisories.length);
  });

  it("writes an iCalendar feed a calendar app accepts: CRLF lines of at most 75 octets, one all-day event per advisory", () => {
    const ics = generated.get("deadlines.ics")!;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(advisories.length);
    expect(ics).not.toMatch(/[^\r]\n/);
    const a = advisories[0]!;
    expect(ics).toContain(`UID:${a.id}@shapi.dev`);
    expect(ics).toContain(`DTSTART;VALUE=DATE:${a.effectiveDate.replaceAll("-", "")}`);
  });

  it("is in sync with the advisories (UPDATE_PUBLIC=1 rewrites site/public)", () => {
    const pub = path.join(site, "public");
    if (process.env.UPDATE_PUBLIC || !existsSync(path.join(pub, "llms.txt"))) {
      rmSync(path.join(pub, "api"), { recursive: true, force: true });
      for (const [name, text] of generated) {
        mkdirSync(path.dirname(path.join(pub, name)), { recursive: true });
        writeFileSync(path.join(pub, name), text);
      }
    }
    const listed = (d: string): string[] => readdirSync(path.join(pub, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listed(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    expect(listed("api").sort()).toEqual([...generated.keys()].filter((f) => f.startsWith("api/")).sort());
    for (const [name, text] of generated) expect(readFileSync(path.join(pub, name), "utf8"), name).toBe(text);
  });
});
