import { getProvider, type Advisory, type LockedCallSite } from "@shapi/core";
import type { FixRepair, FixTestRun } from "@shapi/db";
import { EMPTY, ICONS, html, isoDay, plural, timeAgo, type Html } from "./html";

/* ---------- links and page head ---------- */

type AccountRef = { account: { id: string } };
export const accountHref = (data: AccountRef) => `/a/${data.account.id}`;
export const repoHref = (data: AccountRef, repoId: string) => `${accountHref(data)}/r/${repoId}`;
export const findingHref = (data: AccountRef, id: string) => `${accountHref(data)}/f/${id}`;

export function head(title: string, lead: string, actions: Html = EMPTY): Html {
  return html`<div class="head"><div><h1>${title}</h1><p class="lead">${lead}</p></div><div class="actions">${actions}</div></div>`;
}

/** A bar for "n of total" as inline SVG: the CSP allows no inline style to set a width. */
export function progressBar(done: number, total: number): Html {
  const pct = total ? Math.round((Math.min(done, total) / total) * 100) : 0;
  return html`<svg class="progress" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${done} of ${total}"><rect class="track" width="100" height="8"/><rect class="fill" width="${pct}" height="8"/></svg>`;
}

/* ---------- small pieces ---------- */

type Tone = "ok" | "warn" | "bad" | "info" | "";

export function tag(text: string, tone: Tone | string = "", title?: string): Html {
  return html`<span class="tag ${tone}"${title ? html` title="${title}"` : EMPTY}>${text}</span>`;
}

export const severityTag = (severity: string) => html`<span class="tag sev-${severity}">${severity}</span>`;

/** Scan and PR states share one vocabulary. */
export function stateTag(state: string): Html {
  const tone: Tone = state === "succeeded" || state === "merged" ? "ok" : state === "failed" ? "bad" : state === "closed" ? "" : state === "open" ? "info" : "warn";
  return tag(state, tone);
}

export const kindTag = (kind: "affected" | "exposed" | "ok") => (kind === "affected" ? tag("affected", "bad") : kind === "exposed" ? tag("exposed", "warn") : tag("ok", "ok"));

export const empty = (text: string) => html`<div class="empty">${text}</div>`;

/** "in effect" once a change applies, otherwise "in N days" colored by urgency. */
export const dueTag = (daysUntil: number) => (daysUntil < 0 ? tag("in effect", "bad") : tag(`in ${plural(daysUntil, "day")}`, urgency(daysUntil)));

/** A fix PR's number linked to GitHub, or its branch while it has no number; `button` for the finding page. */
export function prLink(pr: { url: string | null; number: number | null; branch: string }, style: "text" | "button" = "text"): Html {
  if (!pr.url || !pr.number) return html`<span class="mono">${pr.branch}</span>`;
  return style === "button" ? html`<a class="button" href="${pr.url}">${ICONS.external} Pull request #${pr.number}</a>` : html`<a href="${pr.url}">#${pr.number}</a>`;
}

export function crumbs(items: { label: string; href?: string }[]): Html {
  return html`<nav class="crumbs">${items.map((c, i) => html`${i ? html`<span>/</span>` : EMPTY}${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span>${c.label}</span>`}`)}</nav>`;
}

export function section(title: string, body: Html, more?: { label: string; href: string }): Html {
  return html`<section class="section"><div class="title"><h2>${title}</h2>${more ? html`<a class="more" href="${more.href}">${more.label} ${ICONS.arrow}</a>` : EMPTY}</div>${body}</section>`;
}

interface StatCard {
  label: string;
  value: string | number;
  sub?: string;
  icon?: Html;
  tone?: "ok" | "bad" | "";
  href?: string;
}

export function statCard(s: StatCard): Html {
  const inner = html`<div class="label"><span>${s.label}</span>${s.icon ?? EMPTY}</div><div class="value ${s.tone ?? ""}">${s.value}</div>${s.sub ? html`<div class="sub">${s.sub}</div>` : EMPTY}`;
  return s.href ? html`<a class="card stat" href="${s.href}">${inner}</a>` : html`<div class="card stat">${inner}</div>`;
}

/* ---------- health ring ---------- */

export interface Health {
  /** 0 to 100, or null before the first completed scan. */
  score: number | null;
  verdict: string;
  why: string;
}

const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

/** An SVG arc: the score as a fraction of the circumference, colored by tier. */
export function healthRing(h: Health): Html {
  const score = h.score ?? 0;
  const tone = h.score === null ? "" : score >= 90 ? "ok" : score >= 70 ? "warn" : "bad";
  const offset = (RING_C * (1 - score / 100)).toFixed(1);
  return html`<div class="health">
<div class="ring" role="img" aria-label="API health ${h.score ?? "unknown"} of 100">
<svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="${RING_R}"/><circle class="bar ${tone}" cx="60" cy="60" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${offset}"/></svg>
<div class="center"><div class="score">${h.score === null ? "—" : h.score}</div><div class="of">of 100</div></div>
</div>
<div class="verdict">${h.verdict}</div>
<div class="why">${h.why}</div>
</div>`;
}

/* ---------- providers ---------- */

const BRAND: Record<string, string> = {
  github: "#24292f", stripe: "#635bff", slack: "#4a154b", openai: "#10a37f", anthropic: "#d97757", shopify: "#5e8e3e", hubspot: "#ff7a59",
  xero: "#13b5ea", quickbooks: "#2ca01c", "meta-graph": "#0866ff", google: "#4285f4", "google-gemini": "#8e75d9", twilio: "#f22f46", salesforce: "#00a1e0",
  x: "#111111", reddit: "#ff4500", zendesk: "#03363d", intercom: "#1f8ded", sendgrid: "#1a82e2", mailchimp: "#b58b00", plaid: "#111111", square: "#222222",
  paypal: "#003087", "microsoft-graph": "#0078d4", linkedin: "#0a66c2", notion: "#1f1f1f", airtable: "#18bfff", atlassian: "#0052cc", linear: "#5e6ad2",
  discord: "#5865f2", zoom: "#0b5cff", dropbox: "#0061ff", pinterest: "#e60023", resend: "#111111", cloudflare: "#f38020",
};

function hue(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 42%)`;
}

export const providerName = (id: string) => getProvider(id)?.name ?? id;

/**
 * A monogram tile in the provider's color: the mark SHAPI draws for a provider, no trademarked artwork.
 * Inline SVG with presentation attributes, because the CSP allows no inline styles.
 */
export function providerMark(id: string, size: "" | "sm" = ""): Html {
  const name = id === "unknown" ? "?" : providerName(id);
  const words = name.split(/[\s-]+/).filter(Boolean);
  // Initials for multi-word names (QuickBooks Online: QO), the first two letters otherwise (Stripe: St), so same-letter providers stay apart.
  const letters = id === "unknown" ? "?" : words.length > 1 ? words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 2) : name.slice(0, 2);
  const fill = id === "unknown" ? "#64748b" : (BRAND[id] ?? hue(id));
  return html`<svg class="mark-logo ${size}" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="10" fill="${fill}"/><text x="20" y="25.5" text-anchor="middle" font-size="${letters.length > 1 ? 15 : 17}" font-weight="700" fill="#fff" font-family="Inter Variable, Inter, system-ui, sans-serif">${letters}</text></svg>`;
}

interface ProviderStatus {
  id: string;
  callSites: number;
  repos: number;
  affected: number;
  exposed: number;
  /** Days to the nearest deadline that is still ahead, if any. */
  nextDeadline?: number;
}

function providerTone(p: ProviderStatus): Tone {
  if (p.affected) return "bad";
  if (p.exposed || (p.nextDeadline !== undefined && p.nextDeadline <= 90)) return "warn";
  return "ok";
}

export function providerGrid(providers: ProviderStatus[], href: (id: string) => string): Html {
  if (!providers.length) return empty("No third-party API calls found yet. Providers appear after the first scan.");
  return html`<div class="providers">${providers.map((p) => {
    const tone = providerTone(p);
    const status = tone === "bad" ? `${plural(p.affected, "affected call site")}` : tone === "warn" ? (p.exposed ? `${plural(p.exposed, "exposed call site")}` : `deadline in ${plural(p.nextDeadline!, "day")}`) : "healthy";
    return html`<a class="provider" href="${href(p.id)}">${providerMark(p.id)}<span><span class="name">${providerName(p.id)}</span><span class="sub"><span class="dot ${tone}"></span>${status} · ${plural(p.callSites, "call")}</span></span></a>`;
  })}</div>`;
}

/* ---------- deadlines ---------- */

export interface Deadline {
  advisory: Advisory;
  /** Negative when the change is already in effect. */
  daysUntil: number;
  affected: number;
  exposed: number;
}

function urgency(daysUntil: number): Tone {
  return daysUntil <= 30 ? "bad" : daysUntil <= 90 ? "warn" : "ok";
}

const HORIZON = 180;

/**
 * The next 180 days as an inline SVG: the track colored by urgency (red to 30 days, amber to 90, green
 * after), one dot per deadline with a native tooltip, and the ones already in effect stacked at day 0.
 */
export function deadlineTimeline(deadlines: Deadline[], now: Date): Html {
  if (!deadlines.length) return empty("No API changes ahead for the providers in your code.");
  const W = 720;
  const L = 24;
  const R = 696;
  const Y = 66;
  const x = (days: number) => L + (Math.max(0, Math.min(HORIZON, days)) / HORIZON) * (R - L);
  const inEffect = deadlines.filter((d) => d.daysUntil < 0);
  const ahead = deadlines.filter((d) => d.daysUntil >= 0 && d.daysUntil <= HORIZON);
  const later = deadlines.filter((d) => d.daysUntil > HORIZON).length;
  // Dots on the same day step up, so none hides another.
  const taken = new Map<number, number>();
  const dots = ahead.map((d) => {
    const bucket = Math.round(x(d.daysUntil) / 12);
    const n = Math.min(4, taken.get(bucket) ?? 0);
    taken.set(bucket, n + 1);
    const label = `${d.advisory.title} · ${providerName(d.advisory.provider)} · ${d.daysUntil === 0 ? "today" : `in ${plural(d.daysUntil, "day")}`} (${isoDay(d.advisory.effectiveDate)})`;
    return html`<circle class="dot ${urgency(d.daysUntil)}" cx="${x(d.daysUntil).toFixed(1)}" cy="${Y - n * 13}" r="6"><title>${label}</title></circle>`;
  });
  const tick = (days: number, label: string, anchor = "middle", sub?: string) =>
    html`<line class="tick" x1="${x(days)}" x2="${x(days)}" y1="${Y + 9}" y2="${Y + 16}"/><text class="label" x="${x(days)}" y="${Y + 30}" text-anchor="${anchor}">${label}</text>${sub ? html`<text class="label strong" x="${x(days)}" y="${Y + 45}" text-anchor="${anchor}">${sub}</text>` : EMPTY}`;
  return html`<div class="timeline">
<svg class="tl" viewBox="0 0 ${W} ${inEffect.length ? 118 : 104}" width="100%" role="img" aria-label="Deadlines over the next 180 days">
<rect class="zone bad" x="${L}" y="${Y - 3}" width="${(x(30) - L).toFixed(1)}" height="6" rx="3"/>
<rect class="zone warn" x="${x(30).toFixed(1)}" y="${Y - 3}" width="${(x(90) - x(30)).toFixed(1)}" height="6"/>
<rect class="zone ok" x="${x(90).toFixed(1)}" y="${Y - 3}" width="${(R - x(90)).toFixed(1)}" height="6" rx="3"/>
${tick(0, "Today", "start", inEffect.length ? `${inEffect.length} already in effect` : undefined)}${tick(30, "30 days")}${tick(90, "90 days")}${tick(180, isoDay(new Date(now.getTime() + HORIZON * 86_400_000)), "end")}
${inEffect.length ? html`<circle class="dot bad big" cx="${L}" cy="${Y}" r="9"><title>${inEffect.map((d) => d.advisory.title).join("\n")}</title></circle><text class="count" x="${L}" y="${Y + 3.5}" text-anchor="middle">${inEffect.length}</text>` : EMPTY}
${dots}
</svg>
${later ? html`<p class="note">${plural(later, "more deadline")} beyond 180 days.</p>` : EMPTY}
</div>`;
}

export function deadlineRow(d: Deadline, href: string): Html {
  const tone = urgency(d.daysUntil);
  const days = d.daysUntil < 0 ? html`<div class="days ${tone}">now<small>in effect</small></div>` : html`<div class="days ${tone}">${d.daysUntil}<small>${d.daysUntil === 1 ? "day" : "days"}</small></div>`;
  return html`<div class="deadline">${days}<div class="what"><a href="${href}"><b>${d.advisory.title}</b></a><div class="sub">${providerName(d.advisory.provider)} · ${d.advisory.endpoint.method} <span class="mono">${d.advisory.endpoint.path}</span> · ${isoDay(d.advisory.effectiveDate)}</div></div><div class="hits">${severityTag(d.advisory.severity)}${
    d.affected ? tag(`${d.affected} affected`, "bad") : EMPTY
  }${d.exposed ? tag(`${d.exposed} exposed`, "warn") : EMPTY}</div></div>`;
}

/* ---------- activity ---------- */

export interface ActivityEvent {
  at: Date;
  kind: "scan" | "pr" | "merged" | "closed" | "finding";
  tone: Tone;
  text: Html;
  sub?: string;
}

export function activityFeed(events: ActivityEvent[], now: Date): Html {
  if (!events.length) return empty("Nothing yet. Activity appears after the first scan.");
  const icons: Record<ActivityEvent["kind"], Html> = { scan: ICONS.scan, pr: ICONS.pr, merged: ICONS.merged, closed: ICONS.cross, finding: ICONS.alert };
  return html`<div class="feed">${events.map(
    (e) => html`<div class="event"><span class="icon ${e.tone}">${icons[e.kind]}</span><div class="text">${e.text}${e.sub ? html`<span class="sub">${e.sub}</span>` : EMPTY}</div><time datetime="${e.at.toISOString()}" title="${e.at.toISOString()}">${timeAgo(e.at, now)}</time></div>`,
  )}</div>`;
}

/* ---------- call sites and GitHub links ---------- */

export const fileUrl = (repo: string, sha: string, file: string, line?: number) => `https://github.com/${repo}/blob/${sha}/${file}${line ? `#L${line}` : ""}`;
export const commitUrl = (repo: string, sha: string) => `https://github.com/${repo}/commit/${sha}`;

export const callSiteText = (site: Pick<LockedCallSite, "method" | "endpoint">) => `${site.method ?? "?"} ${site.endpoint ?? "?"}`;

/* ---------- the finding page's comparison ---------- */

const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 410: "Gone", 429: "Too Many Requests" };
const statusText = (codes: number[]) => codes.map((c) => `${c}${STATUS_TEXT[c] ? ` ${STATUS_TEXT[c]}` : ""}`).join(" or ");

interface Comparison {
  expected: { value: string; caption: string };
  actual: { value: string; caption: string };
}

/** What the code was written for against what the provider does now, from the advisory's trigger and fix. */
export function comparison(advisory: Advisory, site?: Pick<LockedCallSite, "surface">): Comparison {
  const provider = providerName(advisory.provider);
  const t = advisory.trigger;
  const fix = advisory.fix;
  const ev = advisory.evidence;
  switch (advisory.changeClass) {
    case "status-code": {
      const was = t.statusCodes?.length ? t.statusCodes : ev ? [ev.before.status] : [];
      const now = t.newStatusCodes?.length ? t.newStatusCodes : ev ? [ev.after.status] : [];
      return {
        expected: { value: was.length ? statusText(was) : "the documented status", caption: "The status the code checks for" },
        actual: { value: now.length ? statusText(now) : "a different status", caption: `What ${provider} returns now` },
      };
    }
    case "field-rename": {
      const read = new Set(site?.surface.fields ?? []);
      const pairs = (fix?.fields ?? []).filter((f) => !read.size || [...read].some((r) => r === f.from || r.startsWith(`${f.from}.`)));
      const from = pairs.length ? pairs.map((p) => p.from) : t.fields ?? [];
      return {
        expected: { value: from.length ? from.join(", ") : "the old field", caption: "Response field the code reads" },
        actual: { value: pairs.length ? pairs.map((p) => p.to).join(", ") : "renamed or removed", caption: `Field in ${provider}'s response now` },
      };
    }
    case "enum-added": {
      const values = fix?.enums?.flatMap((e) => e.values) ?? [];
      const compared = site?.surface.enums.flatMap((e) => e.values) ?? [];
      return {
        expected: { value: (compared.length ? compared : values.map((v) => v.from)).join(", ") || "the known values", caption: "Values the code compares against" },
        actual: { value: values.length ? values.map((v) => v.to).join(", ") : "new values", caption: `Values ${provider} sends now` },
      };
    }
    case "version-sunset": {
      const pinned = fix?.path?.from ?? fix?.header?.name ?? fix?.query?.name;
      const sent = site?.surface.headers.find((h) => h.name === fix?.header?.name?.toLowerCase())?.value ?? site?.surface.query.find((q) => q.name === fix?.query?.name)?.value;
      return {
        expected: { value: sent ?? pinned ?? "the retired version", caption: "API version the code pins" },
        actual: { value: fix?.path?.to ?? fix?.header?.value ?? fix?.query?.value ?? `retired on ${advisory.effectiveDate}`, caption: fix ? "Version to send now" : `What ${provider} answers now` },
      };
    }
    default:
      return {
        expected: { value: `${advisory.endpoint.method} ${advisory.endpoint.path} as called today`, caption: "The request the code makes" },
        actual: { value: advisory.migrationNote, caption: `What ${provider} requires now` },
      };
  }
}

export function comparisonView(c: Comparison): Html {
  return html`<div class="compare">
<div class="side-box expected"><h3>Expected by the code</h3><div class="val">${c.expected.value}</div><div class="cap">${c.expected.caption}</div></div>
<div class="arrow">${ICONS.arrow}</div>
<div class="side-box actual"><h3>Actual now</h3><div class="val">${c.actual.value}</div><div class="cap">${c.actual.caption}</div></div>
</div>`;
}

/* ---------- the fix: diff and tests ---------- */

export function diffView(change: FixRepair["changes"][number]): Html {
  const lines = change.diff.split("\n").map((l) => {
    const cls = l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
    return html`<span class="l ${cls}">${l || " "}</span>`;
  });
  return html`<pre class="diff"><div class="file"><span>${change.file}</span><span class="muted">${change.kind === "added" ? "new file" : "modified"}</span></div>${lines}${
    change.truncated ? html`<div class="cut">Diff cut here; the pull request has the whole change.</div>` : EMPTY
  }</pre>`;
}

export function testRunBox(run: FixTestRun | undefined, phase: "before" | "after", test?: string): Html {
  if (!run) return html`<div class="run none"><div class="verdict">${phase === "before" ? "Not run" : "Not reached"}</div><div class="when">${phase === "before" ? "No baseline was recorded." : "The change did not get to a passing run."}</div></div>`;
  const state = run.passed ? "pass" : "fail";
  return html`<div class="run ${state}"><div class="verdict">${run.passed ? ICONS.check : ICONS.cross}${run.passed ? "Passing" : "Failing"} <span class="muted small">· ${run.tests}</span></div><div class="when">${
    phase === "before" ? "Contract test on the original code" : "Same test after the fix"
  }${test ? html` · <span class="mono">${test}</span>` : EMPTY}</div>${run.output ? html`<details><summary>Test output</summary><pre>${run.output}</pre></details>` : EMPTY}</div>`;
}
