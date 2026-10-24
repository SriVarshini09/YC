import { LOGO_SVG, MOTION_CSS } from "./brand";

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

export interface PageUser {
  login: string;
  csrf: string;
}

/** The public documentation site, where the security page and the legal terms live. */
export const DOCS_URL = "https://srivarshini09.github.io/YC";

/** The page shell: no scripts at all, one stylesheet, and a sign-out form when signed in. */
export function page(title: string, body: Html, user?: PageUser): string {
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · SHAPI</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head>
<body>
<header class="top">
  <a class="brand" href="/" aria-label="SHAPI home">${new Html(LOGO_SVG)}</a>
  ${
    user
      ? html`<form method="post" action="/logout" class="signout"><input type="hidden" name="csrf" value="${user.csrf}"><span>${user.login}</span><button type="submit">Sign out</button></form>`
      : ""
  }
</header>
<main>${body}</main>
<footer class="foot"><a href="${DOCS_URL}/">Docs</a> · <a href="${DOCS_URL}/security">Security</a> · <a href="${DOCS_URL}/legal/privacy">Privacy</a> · <a href="${DOCS_URL}/legal/terms">Terms</a></footer>
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

export const STYLES = `
:root { --bg: #fbfbfa; --fg: #1d1f21; --muted: #5f6368; --line: #e3e3e0; --accent: #1f6feb; --warn: #9a6700; --bad: #cf222e; --ok: #1a7f37; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #30363d; --accent: #4493f8; --warn: #d29922; --bad: #f85149; --ok: #3fb950; --card: #161b22; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
header.top { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; color: var(--fg); text-decoration: none; }
.brand svg { display: block; height: 26px; width: auto; }
h1.logo { margin: 8px 0 12px; }
h1.logo svg { display: block; height: 52px; width: auto; }
.signout { display: flex; gap: 12px; align-items: center; color: var(--muted); }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
footer.foot { max-width: 1040px; margin: 0 auto; padding: 0 16px 32px; font-size: 13px; color: var(--muted); }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; }
p.lead { color: var(--muted); margin: 0 0 24px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); }
.tag.bad { color: var(--bad); border-color: var(--bad); }
.tag.warn { color: var(--warn); border-color: var(--warn); }
.tag.ok { color: var(--ok); border-color: var(--ok); }
button, .button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
.button.primary, button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
form.settings { display: grid; gap: 12px; max-width: 520px; }
form.settings label { display: grid; gap: 4px; }
form.settings input[type=number] { width: 120px; font: inherit; padding: 4px 8px; }
.check { display: flex !important; grid-template-columns: none; gap: 8px; align-items: flex-start; }
.note { font-size: 13px; color: var(--muted); }
form.inline { display: inline; }
.notice { border-left: 3px solid var(--warn); padding: 8px 12px; background: var(--card); margin: 16px 0; }
@media (max-width: 640px) { th:nth-child(n+4), td:nth-child(n+4) { display: none; } header.top { padding: 12px 16px; } }
${MOTION_CSS}
`;
