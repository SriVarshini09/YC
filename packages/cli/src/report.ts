import { styleText } from "node:util";
import type { Finding } from "@shapi/core";
import type { ScanOutcome } from "./scan";

type Style = Parameters<typeof styleText>[0];

/** Where the hosted service lives: fix PRs and a dashboard on every push, through the GitHub App. */
export const APP_URL = "https://app.shapi.dev";

/** The first line of every human-readable run. */
export function title(color: boolean): string {
  const paint = (style: Style, s: string) => (color ? styleText(style, s) : s);
  return `${paint("bold", "SHAPI")}  ${paint("dim", "third-party API changes, caught and fixed")}`;
}

/** Human-readable scan report. Plain padded columns; color only when `color` is set. */
export function renderText(o: ScanOutcome, color: boolean): string {
  const paint = (style: Style, s: string) => (color ? styleText(style, s) : s);
  const out: string[] = [];
  const { lock, match } = o;
  const providers = lock.providers;
  const unresolved = lock.callSites.filter((c) => !c.resolved).length;

  out.push(title(color));
  out.push(`${paint("bold", "scan")}  ${o.label}`);
  out.push(
    paint(
      "dim",
      [plural(o.filesScanned, "file"), plural(lock.callSites.length, "call site"), plural(providers.length, "provider"), `${o.elapsedMs} ms`].join(" · "),
    ),
  );
  if (o.skipped.length) out.push(paint("dim", `${plural(o.skipped.length, "file")} not scanned: ${[...new Set(o.skipped.map((s) => s.reason))].join("; ")}`));
  out.push("");

  out.push(paint("bold", "Providers"));
  if (providers.length === 0) out.push("  none found");
  const idWidth = Math.max(0, ...providers.map((p) => p.id.length));
  for (const p of providers) {
    const sites = plural(p.callSites, "call site");
    out.push(`  ${p.id.padEnd(idWidth)}  ${sites.padEnd(13)}  ${paint("dim", p.declaredBy.join(", "))}`.trimEnd());
  }
  out.push("");

  out.push(paint("bold", `Affected call sites (${match.affected.length})`));
  if (match.affected.length === 0) out.push("  none");
  for (const f of match.affected) out.push(...renderFinding(f, paint));
  out.push("");

  if (match.possible.length > 0) {
    out.push(paint("bold", `Possibly affected, check these (${match.possible.length})`));
    for (const f of match.possible) out.push(...renderFinding(f, paint));
    out.push("");
  }

  if (match.exposed.length > 0) {
    out.push(paint("bold", `Exposed, not affected (${match.exposed.length})`));
    for (const f of match.exposed) {
      out.push(`  ${f.callSite.file}:${f.callSite.line}  ${f.advisory.id}  ${paint("dim", f.reasons.join("; "))}`);
    }
    out.push("");
  }

  if (match.unresolved.length > 0) {
    out.push(paint("bold", `Could not tell, check these by hand (${match.unresolved.length})`));
    for (const u of match.unresolved) {
      const reach = u.advisories.length === 1 ? u.advisories[0] : `${u.advisories.length} advisories`;
      out.push(`  ${u.callSite.file}:${u.callSite.line}  ${u.callSite.provider}  ${paint("dim", `${u.reason}; could reach ${reach}`)}`);
    }
    out.push("");
  }

  out.push(paint("bold", "Deadlines in the next 90 days"));
  if (match.upcoming.length === 0) out.push("  none for the providers in this repo");
  for (const u of match.upcoming) {
    const where = u.callSites > 0 ? plural(u.callSites, "call site") : "declared dependency";
    out.push(`  ${u.advisory.effectiveDate} (${u.daysUntil} days)  ${u.advisory.provider}  ${u.advisory.title}  ${paint("dim", where)}`);
  }

  if (unresolved > 0) {
    out.push("");
    out.push(paint("dim", `${plural(unresolved, "call site")} could not be fully resolved (see --json or --out api.lock).`));
  }

  out.push("");
  out.push(paint("bold", "Next"));
  if (match.affected.length > 0) out.push(`  npx shapi-cli fix ${o.fixTarget}  ${paint("dim", "fix the affected call sites test-first (nothing changes until you add --write or --pr)")}`);
  out.push(`  ${APP_URL}  ${paint("dim", "install the GitHub App: every push scanned, verified fix PRs, and a dashboard")}`);
  return out.join("\n") + "\n";
}

const SEVERITY_STYLE: Record<string, Style> = { critical: "red", high: "yellow", medium: "cyan", low: "gray" };

function renderFinding(f: Finding, paint: (style: Style, s: string) => string): string[] {
  const sev = f.advisory.severity.toUpperCase().padEnd(8);
  const site = f.callSite;
  const call = `${site.method ?? "?"} ${site.endpoint ?? "?"}`;
  const indent = " ".repeat(12);
  const lines = [
    `  ${paint(SEVERITY_STYLE[f.advisory.severity] ?? "white", sev)}  ${paint("bold", `${site.file}:${site.line}`)}  ${call}`,
    `${indent}${f.advisory.title}  ${paint("dim", `[${f.advisory.id}]`)}`,
    `${indent}why: ${f.reasons.join("; ")}`,
    `${indent}fix: ${f.advisory.migrationNote}`,
  ];
  if (f.advisory.status === "unverified") lines.push(`${indent}${paint("dim", "note: unverified advisory (secondary reports only)")}`);
  return lines;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
