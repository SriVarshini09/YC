import type { Octokit } from "@octokit/rest";
import type { Advisory } from "@shapi/core";
import { STOP_LABEL, type PrLimits } from "./policy";

/** One issue per repository, like Renovate's Dependency Dashboard: what SHAPI did, what waits, and checkboxes to act. */
export const DASHBOARD_TITLE = "SHAPI Dashboard";
const MARKER = "<!-- shapi-dashboard -->";

export interface DashboardInput {
  open: { advisory: Advisory; number: number; url: string; stopped?: boolean }[];
  waiting: { advisory: Advisory; reason: string }[];
  closed: { advisory: Advisory; number?: number; url?: string }[];
  /** Affected call sites with no automatic fix yet. */
  manual: { advisory: Advisory; callSites: number }[];
  upcoming: { advisory: Advisory; daysUntil: number }[];
  paused: boolean;
  limits: PrLimits;
}

export interface DashboardIntents {
  createNow: Set<string>;
  retry: Set<string>;
  paused: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pr = (number?: number, url?: string) => (number && url ? ` [#${number}](${url})` : "");

export function renderDashboard(d: DashboardInput): string {
  const lines = [
    MARKER,
    "SHAPI checks this repository's third-party API calls against known API changes and opens a verified fix PR for each one it can fix.",
    "",
    `- [${d.paused ? "x" : " "}] <!-- shapi:pause --> Pause SHAPI on this repository`,
    "",
  ];
  const section = (title: string, rows: string[], empty?: string) => {
    if (!rows.length && !empty) return;
    lines.push(`## ${title}`, "", ...(rows.length ? rows : [empty!]), "");
  };
  section(
    "Open fix PRs",
    d.open.map((o) => `- ${o.advisory.title}${pr(o.number, o.url)}${o.stopped ? ` (not updated: \`${STOP_LABEL}\` or edited by someone)` : ""}`),
    "None.",
  );
  section(
    "Waiting",
    d.waiting.map((w) => `- [ ] <!-- shapi:create:${w.advisory.id} --> ${w.advisory.title} (${w.reason}). Tick to open it now.`),
  );
  section(
    "Closed without merging",
    d.closed.map((c) => `- [ ] <!-- shapi:retry:${c.advisory.id} --> ${c.advisory.title}${pr(c.number, c.url)}. Tick to open it again.`),
  );
  section(
    "Needs a manual fix",
    d.manual.map((m) => `- ${m.advisory.title}: ${m.callSites} call site${m.callSites === 1 ? "" : "s"}. ${m.advisory.migrationNote}`),
  );
  section(
    "Upcoming deadlines",
    d.upcoming.map((u) => `- ${u.advisory.title}: in ${u.daysUntil} day${u.daysUntil === 1 ? "" : "s"} (${u.advisory.effectiveDate})`),
  );
  lines.push(
    "---",
    `Limits: ${plural(d.limits.hourly, "new PR")} per hour, ${d.limits.open} open at once. Add the \`${STOP_LABEL}\` label to a SHAPI PR to stop updates to it.`,
  );
  return lines.join("\n") + "\n";
}

/** Read the ticked checkboxes back from the dashboard body. */
export function parseDashboard(body: string | null | undefined): DashboardIntents {
  const intents: DashboardIntents = { createNow: new Set(), retry: new Set(), paused: false };
  for (const m of (body ?? "").matchAll(/^\s*- \[[xX]\] <!-- shapi:(pause|create:([^\s>]+)|retry:([^\s>]+)) -->/gm)) {
    if (m[1] === "pause") intents.paused = true;
    else if (m[2]) intents.createNow.add(m[2]);
    else if (m[3]) intents.retry.add(m[3]);
  }
  return intents;
}

export function isDashboard(body: string | null | undefined): boolean {
  return (body ?? "").startsWith(MARKER);
}

export interface DashboardIssue {
  number: number;
  body: string;
  state: "open" | "closed";
}

export async function readDashboard(octokit: Octokit, owner: string, repo: string, issueNumber: number): Promise<DashboardIssue | undefined> {
  try {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
    return { number: data.number, body: data.body ?? "", state: data.state === "closed" ? "closed" : "open" };
  } catch (err) {
    if ([404, 410].includes((err as { status?: number }).status ?? 0)) return undefined;
    throw err;
  }
}

/**
 * Create the dashboard issue, or update it when its body changed. A dashboard someone closed stays
 * closed (and is not updated), so closing it is a way to turn it off.
 */
export async function upsertDashboard(
  octokit: Octokit,
  target: { owner: string; repo: string; issueNumber?: number | null },
  body: string,
): Promise<{ number: number; action: "created" | "updated" | "unchanged" | "closed" }> {
  const { owner, repo } = target;
  const current = target.issueNumber ? await readDashboard(octokit, owner, repo, target.issueNumber) : undefined;
  if (current?.state === "closed") return { number: current.number, action: "closed" };
  if (current) {
    if (current.body.replace(/\r\n/g, "\n") === body) return { number: current.number, action: "unchanged" };
    await octokit.rest.issues.update({ owner, repo, issue_number: current.number, body });
    return { number: current.number, action: "updated" };
  }
  const { data } = await octokit.rest.issues.create({ owner, repo, title: DASHBOARD_TITLE, body });
  return { number: data.number, action: "created" };
}
