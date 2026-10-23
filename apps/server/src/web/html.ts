import { createHash } from "node:crypto";
import { STYLES } from "./styles";

/** Markup that is already safe. Everything else placed in an `html` template is escaped. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function render(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escape(value);
}

/** Tagged template: interpolated values are HTML-escaped unless they are Html (or arrays of it). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!));
  return new Html(out);
}

export const EMPTY = new Html("");

export interface PageUser {
  login: string;
  csrf: string;
}

/** The user's choice; "auto" follows the operating system. */
export type Theme = "auto" | "light" | "dark";
export const THEMES: Theme[] = ["auto", "light", "dark"];

/** The public documentation site, where the security page and the legal terms live. */
export const DOCS_URL = "https://srivarshini09.github.io/YC";

export type NavKey = "overview" | "repositories" | "findings" | "fixes" | "deadlines" | "advisories" | "settings" | "billing";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  icon: Html;
  /** A number shown at the right; `bad` colors it red. */
  count?: number;
  bad?: boolean;
}

/** The account the pages belong to, for the sidebar. */
export interface Workspace {
  id: string;
  login: string;
  type: string;
  nav: NavItem[];
  active?: NavKey;
}

export interface Shell {
  user?: PageUser;
  theme?: Theme;
  workspace?: Workspace;
  /** Hide the sidebar: the sign-in page and the account picker. */
  bare?: boolean;
}

// Outline icons (stroke, 24-unit grid), drawn here so no asset leaves this server.
const icon = (paths: string) => new Html(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`);
export const ICONS = {
  overview: icon('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  repositories: icon('<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5V4.5"/><path d="M8 6h8M8 10h8"/>'),
  findings: icon('<path d="M12 3 2.5 20h19z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  fixes: icon('<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M6 7.5v9"/><path d="M18 16.5V10a3 3 0 0 0-3-3h-3"/><path d="m14 4.5-2.5 2.5L14 9.5"/>'),
  deadlines: icon('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 15h3"/>'),
  advisories: icon('<path d="M12 2.5 4 6v6c0 4.5 3.3 8.2 8 9.5 4.7-1.3 8-5 8-9.5V6z"/><path d="M12 8v4.5"/><circle cx="12" cy="16" r=".6" fill="currentColor"/>'),
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  billing: icon('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6 15h4"/>'),
  scan: icon('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>'),
  pr: icon('<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M6 7.5v9"/><path d="M18 16.5V10a3 3 0 0 0-3-3h-3"/>'),
  merged: icon('<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 7.5v9"/><path d="M6 10a6 6 0 0 0 6 2h3.5"/>'),
  alert: icon('<path d="M12 3 2.5 20h19z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  check: icon('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  cross: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  arrow: icon('<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>'),
  external: icon('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  code: icon('<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/><path d="m14 4-4 16"/>'),
  providers: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
};

export const LOGO = new Html('<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 4 6v6c0 4.5 3.3 8.2 8 9.5 4.7-1.3 8-5 8-9.5V6z"/><path d="m13.5 8-4 5.5h5l-4 5.5"/></svg>');

/** The sidebar entries for one account, in order. Counts are filled in by the page. */
export function navFor(accountId: string, counts: Partial<Record<NavKey, { count: number; bad?: boolean }>> = {}): NavItem[] {
  const base = `/a/${accountId}`;
  const item = (key: NavKey, label: string, href: string): NavItem => ({ key, label, href, icon: ICONS[key], ...(counts[key] ?? {}) });
  return [
    item("overview", "Overview", base),
    item("repositories", "Repositories", `${base}/repositories`),
    item("findings", "Findings", `${base}/findings`),
    item("fixes", "Fix PRs", `${base}/fixes`),
    item("deadlines", "Deadlines", `${base}/deadlines`),
    item("advisories", "Advisories", `${base}/advisories`),
    item("settings", "Settings", `${base}/settings`),
    item("billing", "Billing", `${base}/billing`),
  ];
}

export const initials = (name: string) => name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?";

function sidebar(shell: Shell): Html {
  const { user, workspace, theme = "auto" } = shell;
  const themeForm = user
    ? html`<form method="post" action="/theme" class="theme"><input type="hidden" name="csrf" value="${user.csrf}"><span>Theme</span>${THEMES.map(
        (t) => html`<button type="submit" name="theme" value="${t}" class="${t === theme ? "on" : ""}">${t[0]!.toUpperCase() + t.slice(1)}</button>`,
      )}</form>`
    : EMPTY;
  return html`<aside class="side">
  <a class="brand" href="/"><span class="logo">${LOGO}</span>SHAPI</a>
  ${
    workspace
      ? html`<div class="account"><span class="avatar">${initials(workspace.login)}</span><span class="who"><b>${workspace.login}</b><span>${workspace.type}</span></span><a href="/" title="Switch account">Switch</a></div>
  <nav class="nav">
    <div class="group">Monitor</div>
    ${workspace.nav.slice(0, 6).map(navLink(workspace.active))}
    <div class="group">Account</div>
    ${workspace.nav.slice(6).map(navLink(workspace.active))}
  </nav>`
      : EMPTY
  }
  <div class="foot">
    ${user ? html`<form method="post" action="/logout" class="signout"><input type="hidden" name="csrf" value="${user.csrf}"><span>${user.login}</span><button type="submit">Sign out</button></form>` : EMPTY}
    ${themeForm}
    <div><a href="${DOCS_URL}">Docs</a> · <a href="${DOCS_URL}/security">Security</a> · <a href="${DOCS_URL}/legal/privacy">Privacy</a></div>
  </div>
</aside>`;
}

const navLink = (active?: NavKey) => (item: NavItem) =>
  html`<a href="${item.href}" class="${item.key === active ? "active" : ""}">${item.icon}<span class="label">${item.label}</span>${
    item.count ? html`<span class="count ${item.bad ? "bad" : ""}">${item.count}</span>` : EMPTY
  }</a>`;

/** The page shell: no scripts at all, one stylesheet, the sidebar when signed in. */
export function page(title: string, body: Html, shell: Shell = {}): string {
  const theme = shell.theme && shell.theme !== "auto" ? shell.theme : undefined;
  return `<!doctype html>${html`<html lang="en"${theme ? html` data-theme="${theme}"` : EMPTY}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · SHAPI</title>
<link rel="stylesheet" href="/static/app.css?v=${STYLES_VERSION}">
</head>
<body>
${shell.bare ? html`<main class="hero">${body}</main>` : html`${sidebar(shell)}<main class="main"><div class="wrap">${body}</div></main>`}
</body>
</html>`}`;
}

export function timeAgo(date: Date | string | null | undefined, now = new Date()): string {
  if (!date) return "never";
  const seconds = Math.round((now.getTime() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** Short commit id. */
export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const isoDay = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Changes with the stylesheet, so browsers refetch it after a deploy despite the cache header. */
export const STYLES_VERSION = createHash("sha256").update(STYLES).digest("hex").slice(0, 10);

export { STYLES };
