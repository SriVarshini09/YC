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
  /** Fixes SHAPI cannot open because their branch has someone else's commits (SHAPI never force-pushes over them). */
  blocked?: { advisory: Advisory; branch: string; number?: number; url?: string; retried?: boolean }[];
  /** Affected call sites with no automatic fix yet. */
  manual: { advisory: Advisory; callSites: number }[];
  upcoming: { advisory: Advisory; daysUntil: number }[];
  paused: boolean;
  /** Paused from the SHAPI web app (separate from this issue's checkbox). */
  pausedFromWeb?: boolean;
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
  if (d.pausedFromWeb) lines.push("SHAPI is also paused on this repository from the SHAPI web app; resume it there.", "");
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
    "Needs you",
    (d.blocked ?? []).map((b) => {
      const why = `the branch \`${b.branch}\` has commits that are not SHAPI's, so SHAPI leaves it alone`;
      // A fix closed without merging is opened again only when asked, so its row keeps the retry box.
      // Ticked while the branch was still there: the box comes back unticked, so say why nothing was opened.
      const retried = b.retried ? " You ticked this, but the branch still has those commits, so nothing was opened." : "";
      return b.number
        ? `- [ ] <!-- shapi:retry:${b.advisory.id} --> ${b.advisory.title}${pr(b.number, b.url)}: ${why}.${retried} Delete the branch, then tick to open the fix again.`
        : `- ${b.advisory.title}: ${why}. Delete the branch and SHAPI opens the fix on its next scan.`;
    }),
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
 * closed (and is not updated), so closing it is a way to turn it off. `seen` is the boxes the body was
 * rendered from: a box a maintainer ticked on the issue since then (or the pause box they toggled) is
 * carried into the new body instead of being overwritten. Returns the body the issue now has (`body`
 * itself for a closed dashboard).
 */
export async function upsertDashboard(
  octokit: Octokit,
  target: { owner: string; repo: string; issueNumber?: number | null },
  body: string,
  seen?: DashboardIntents,
): Promise<{ number: number; action: "created" | "updated" | "unchanged" | "closed"; body: string }> {
  const { owner, repo } = target;
  const current = target.issueNumber ? await readDashboard(octokit, owner, repo, target.issueNumber) : undefined;
  if (current?.state === "closed") return { number: current.number, action: "closed", body };
  if (current) {
    const next = seen ? keepNewTicks(body, seen, parseDashboard(current.body)) : body;
    if (current.body.replace(/\r\n/g, "\n") === next) return { number: current.number, action: "unchanged", body: next };
    await octokit.rest.issues.update({ owner, repo, issue_number: current.number, body: next });
    return { number: current.number, action: "updated", body: next };
  }
  const { data } = await octokit.rest.issues.create({ owner, repo, title: DASHBOARD_TITLE, body });
  return { number: data.number, action: "created", body };
}

/** Tick or untick the box with this marker, when `body` has one. */
function setBox(body: string, marker: string, ticked: boolean): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`^(\\s*- )\\[[ xX]\\]( <!-- shapi:${escaped} -->)`, "m"), `$1[${ticked ? "x" : " "}]$2`);
}

/** Apply to `body` what a maintainer changed on the issue since `seen` was read: new ticks, and the pause box. */
function keepNewTicks(body: string, seen: DashboardIntents, now: DashboardIntents): string {
  let next = body;
  if (now.paused !== seen.paused) next = setBox(next, "pause", now.paused);
  for (const id of now.createNow) if (!seen.createNow.has(id)) next = setBox(next, `create:${id}`, true);
  for (const id of now.retry) if (!seen.retry.has(id)) next = setBox(next, `retry:${id}`, true);
  return next;
}
