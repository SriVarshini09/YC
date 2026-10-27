/**
 * The one stylesheet, served at /static/app.css. No scripts anywhere: the theme is a cookie read on
 * the server, charts are inline SVG, and hover tooltips are CSS. Colors are tokens on :root, with a
 * dark set under prefers-color-scheme (unless the user chose light) and under an explicit dark choice.
 */
const DARK = `
  --bg: #0b1220; --card: #111a2e; --card-2: #0f172a; --fg: #e5e9f2; --fg-2: #c7d0e0; --muted: #94a3b8; --line: #1f2a44; --line-2: #2c3a5c;
  --accent: #4f8ff7; --accent-2: #3b7cf0; --accent-soft: #15295a; --accent-ink: #9cc0ff;
  --navy: #070f22; --navy-2: #0c1730; --side-fg: #b9c4de; --side-muted: #6f7ea3; --side-line: rgba(255,255,255,.07);
  --ok: #4ade80; --ok-bg: #0f2e1c; --warn: #fbbf24; --warn-bg: #3a2a08; --bad: #f87171; --bad-bg: #3b1212; --info: #93c5fd; --info-bg: #15295a;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -16px rgba(0,0,0,.6); --shadow-hover: 0 2px 4px rgba(0,0,0,.4), 0 14px 32px -14px rgba(79,143,247,.35);
  color-scheme: dark;
`;

import { MOTION_CSS } from "./brand";

export const STYLES = `
@font-face { font-family: "Inter Variable"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/static/inter.woff2) format("woff2"); }
:root {
  --bg: #f3f6fb; --card: #ffffff; --card-2: #f8fafc; --fg: #0f172a; --fg-2: #334155; --muted: #64748b; --line: #e2e8f0; --line-2: #cbd5e1;
  --accent: #2563eb; --accent-2: #1d4ed8; --accent-soft: #dbeafe; --accent-ink: #1e40af;
  --navy: #0b1b3a; --navy-2: #102449; --side-fg: #c3cde6; --side-muted: #7f8db0; --side-line: rgba(255,255,255,.08);
  --ok: #15803d; --ok-bg: #dcfce7; --warn: #b45309; --warn-bg: #fef3c7; --bad: #b91c1c; --bad-bg: #fee2e2; --info: #1d4ed8; --info-bg: #dbeafe;
  --shadow: 0 1px 2px rgba(15,23,42,.04), 0 8px 24px -16px rgba(15,23,42,.18);
  --shadow-hover: 0 2px 4px rgba(15,23,42,.05), 0 14px 32px -14px rgba(37,99,235,.28);
  --radius: 14px; --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK}} }
:root[data-theme="dark"] {${DARK}}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif; font-feature-settings: "cv11", "ss01"; display: flex; min-height: 100vh; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2, h3 { margin: 0; letter-spacing: -.01em; }
h1 { font-size: 24px; font-weight: 650; }
h2 { font-size: 15px; font-weight: 600; }
p { margin: 0; }
code, .mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.note { font-size: 12.5px; color: var(--muted); }
.lead { color: var(--muted); margin: 4px 0 0; }
.stack { display: grid; gap: 10px; align-content: start; }
.grid > * { min-width: 0; }
.ink-bad { color: var(--bad); } .ink-ok { color: var(--ok); }
.marks { display: flex; gap: 4px; align-items: center; }
.reasons { margin: 6px 0 0; padding-left: 18px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }

/* sidebar */
.side { position: fixed; top: 0; bottom: 0; left: 0; width: 248px; background: linear-gradient(180deg, var(--navy) 0%, var(--navy-2) 100%); color: var(--side-fg); display: flex; flex-direction: column; padding: 18px 14px; gap: 18px; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; color: #fff; font-weight: 700; font-size: 17px; letter-spacing: .01em; padding: 4px 8px; }
.brand:hover { text-decoration: none; }
.brand svg { display: block; height: 34px; width: auto; }
.mark { display: inline-grid; flex: none; } .mark svg { display: block; width: 48px; height: 48px; border-radius: 13px; box-shadow: 0 10px 24px -12px rgba(11,31,77,.8); }
.mark.big svg { width: 56px; height: 56px; border-radius: 15px; }
.account { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; background: rgba(255,255,255,.05); border: 1px solid var(--side-line); }
.avatar { width: 30px; height: 30px; border-radius: 8px; background: #1e3a8a; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; }
.account .who { min-width: 0; flex: 1; }
.account .who b { display: block; color: #fff; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account .who span { font-size: 11.5px; color: var(--side-muted); }
.account a { color: var(--side-muted); font-size: 12px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav .group { font-size: 10.5px; text-transform: uppercase; letter-spacing: .12em; color: var(--side-muted); padding: 12px 10px 4px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--side-fg); font-weight: 500; transition: background .12s, color .12s; }
.nav a svg { width: 17px; height: 17px; flex: none; opacity: .85; }
.nav a:hover { background: rgba(255,255,255,.07); color: #fff; text-decoration: none; }
.nav a.active { background: var(--accent); color: #fff; box-shadow: 0 8px 18px -10px rgba(37,99,235,.9); }
.nav a.active svg { opacity: 1; }
.nav .count { margin-left: auto; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,.12); color: #fff; font-variant-numeric: tabular-nums; }
.nav a.active .count { background: rgba(255,255,255,.25); }
.nav .count.bad { background: #ef4444; }
.side .foot { margin-top: auto; display: grid; gap: 10px; padding-top: 14px; border-top: 1px solid var(--side-line); font-size: 12.5px; color: var(--side-muted); }
.side .foot a { color: var(--side-muted); }
.side .foot a:hover { color: #fff; }
.signout { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.signout span { color: var(--side-fg); font-weight: 500; }
.signout button { background: transparent; color: var(--side-muted); border: 1px solid var(--side-line); padding: 4px 10px; font-size: 12px; }
.signout button:hover { color: #fff; border-color: rgba(255,255,255,.3); background: transparent; }
.theme { display: flex; align-items: center; gap: 6px; }
.theme button { background: transparent; color: var(--side-muted); border: 1px solid var(--side-line); padding: 3px 9px; font-size: 11.5px; border-radius: 6px; }
.theme button:hover { background: rgba(255,255,255,.08); color: #fff; }
.theme button.on { background: rgba(255,255,255,.14); color: #fff; }

/* main */
.main { margin-left: 248px; flex: 1; min-width: 0; padding: 28px 32px 72px; }
.wrap { max-width: 1240px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
.wrap > *, .section > * { min-width: 0; }
.column { display: grid; gap: 22px; align-content: start; min-width: 0; }
.crumbs { font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--accent); }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.head .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.section { display: grid; gap: 10px; }
.section > .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.section > .title .more { font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; }
.section > .title .more svg { width: 14px; height: 14px; }

.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px; }
.card.tight { padding: 0; overflow: hidden; }
a.card { display: block; color: inherit; transition: transform .14s, box-shadow .14s, border-color .14s; }
a.card:hover { text-decoration: none; transform: translateY(-1px); box-shadow: var(--shadow-hover); border-color: var(--line-2); }
.grid { display: grid; gap: 16px; }
.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.span-2 { grid-column: span 2; }
.overview-top { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; }

/* stat cards */
.stat { display: grid; gap: 6px; align-content: start; }
.stat .label { font-size: 12.5px; color: var(--muted); font-weight: 500; display: flex; align-items: center; justify-content: space-between; }
.stat .label svg { width: 16px; height: 16px; color: var(--accent); }
.stat .value { font-size: 28px; font-weight: 650; letter-spacing: -.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat .value.bad { color: var(--bad); }
.stat .value.ok { color: var(--ok); }
.stat .sub { font-size: 12.5px; color: var(--muted); }

/* health ring */
.health { display: grid; justify-items: center; text-align: center; gap: 8px; }
.ring { position: relative; width: 150px; height: 150px; }
.ring svg { width: 150px; height: 150px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 11; stroke-linecap: round; }
.ring .track { stroke: var(--line); }
.ring .bar { stroke: var(--accent); }
.ring .bar.ok { stroke: var(--ok); } .ring .bar.warn { stroke: var(--warn); } .ring .bar.bad { stroke: var(--bad); }
.ring .center { position: absolute; inset: 0; display: grid; place-content: center; }
.ring .score { font-size: 34px; font-weight: 700; letter-spacing: -.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.ring .of { font-size: 11px; color: var(--muted); }
.health .verdict { font-weight: 600; }
.health .why { font-size: 12.5px; color: var(--muted); max-width: 240px; }

/* tags and status */
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; letter-spacing: .01em; background: var(--card-2); color: var(--fg-2); border: 1px solid var(--line); white-space: nowrap; vertical-align: middle; }
.tag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .85; }
.tag.plain::before { display: none; }
.tag.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.tag.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.tag.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.tag.info { background: var(--info-bg); color: var(--info); border-color: transparent; }
.tag.sev-critical { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.tag.sev-high { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.tag.sev-medium { background: var(--info-bg); color: var(--info); border-color: transparent; }
.tag.sev-low { background: var(--card-2); color: var(--muted); }

/* tables */
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 11px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; background: var(--card-2); }
tbody tr { transition: background .1s; }
tbody tr:hover { background: var(--card-2); }
tr:last-child td { border-bottom: 0; }
td .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
tr.affected td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
tr.affected { background: color-mix(in srgb, var(--bad-bg) 45%, transparent); }
tr.affected:hover { background: color-mix(in srgb, var(--bad-bg) 70%, transparent); }
tr.exposed td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
.empty { padding: 28px 20px; text-align: center; color: var(--muted); }
.group-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--card-2); border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); font-weight: 600; }
.group-head:first-child { border-top: 0; }
.group-head .meta { margin-left: auto; font-size: 12px; color: var(--muted); font-weight: 500; display: flex; gap: 8px; align-items: center; }

/* buttons and forms */
button, .button { font: inherit; font-weight: 500; font-size: 13px; padding: 7px 14px; border-radius: 9px; border: 1px solid var(--line-2); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: background .12s, border-color .12s, box-shadow .12s; }
button:hover, .button:hover { background: var(--card-2); text-decoration: none; border-color: var(--muted); }
button svg, .button svg { width: 15px; height: 15px; }
.button.primary, button.primary { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 6px 14px -8px rgba(37,99,235,.8); }
.button.primary:hover, button.primary:hover { background: var(--accent-2); border-color: var(--accent-2); }
form.inline { display: inline; }
form.settings { display: grid; gap: 16px; }
form.settings label { display: grid; gap: 5px; font-weight: 500; }
form.settings input[type=number], form.settings input[type=url] { font: inherit; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--card); color: var(--fg); }
form.settings input[type=number] { width: 120px; }
form.settings input:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.check { display: flex !important; gap: 10px; align-items: flex-start; font-weight: 500; }
.check input { margin-top: 3px; accent-color: var(--accent); }
.notice { border-left: 3px solid var(--accent); padding: 10px 14px; background: var(--accent-soft); color: var(--accent-ink); border-radius: 8px; font-size: 13px; }
.notice.warn { border-color: var(--warn); background: var(--warn-bg); color: var(--warn); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters a { padding: 5px 12px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg-2); font-size: 12.5px; font-weight: 500; background: var(--card); }
.filters a:hover { text-decoration: none; border-color: var(--muted); }
.filters a.on { background: var(--accent); border-color: var(--accent); color: #fff; }

/* deadline timeline (inline SVG) */
.timeline { display: grid; gap: 10px; }
.tl { display: block; width: 100%; height: auto; overflow: visible; }
.tl .zone { opacity: .35; } .tl .zone.bad { fill: var(--bad); } .tl .zone.warn { fill: var(--warn); } .tl .zone.ok { fill: var(--ok); }
.tl .tick { stroke: var(--line-2); stroke-width: 1.5; }
.tl .label { font-size: 11px; fill: var(--muted); }
.tl .label.strong { fill: var(--fg-2); font-weight: 600; }
.tl .dot { stroke: var(--card); stroke-width: 3; transition: r .1s; }
.tl .dot:hover { r: 9; }
.tl .dot.big { stroke-width: 2.5; }
.tl .dot.bad { fill: var(--bad); } .tl .dot.warn { fill: var(--warn); } .tl .dot.ok { fill: var(--ok); }
.tl .count { font-size: 10px; font-weight: 700; fill: #fff; pointer-events: none; }
.deadline { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.deadline:first-of-type { border-top: 0; }
.deadline .days { text-align: center; border-radius: 10px; padding: 6px 4px; font-weight: 700; font-size: 15px; line-height: 1; font-variant-numeric: tabular-nums; }
.deadline .days small { display: block; font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; margin-top: 3px; opacity: .85; }
.deadline .days.bad { background: var(--bad-bg); color: var(--bad); } .deadline .days.warn { background: var(--warn-bg); color: var(--warn); } .deadline .days.ok { background: var(--ok-bg); color: var(--ok); }
.deadline .what b { font-weight: 600; }
.deadline .what .sub { font-size: 12px; color: var(--muted); }
.deadline .hits { display: flex; gap: 6px; }

/* providers */
.providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; }
.provider { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); transition: box-shadow .14s, border-color .14s, transform .14s; color: inherit; }
.provider:hover { text-decoration: none; border-color: var(--line-2); box-shadow: var(--shadow-hover); transform: translateY(-1px); }
.provider .name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider .sub { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--muted); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.mark-logo { width: 38px; height: 38px; flex: none; display: inline-block; vertical-align: middle; }
.mark-logo.sm { width: 24px; height: 24px; }

/* activity */
.feed { display: grid; }
.event { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 11px 0; border-top: 1px solid var(--line); }
.event:first-child { border-top: 0; padding-top: 0; }
.event .icon { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--card-2); color: var(--muted); }
.event .icon svg { width: 15px; height: 15px; }
.event .icon.ok { background: var(--ok-bg); color: var(--ok); } .event .icon.bad { background: var(--bad-bg); color: var(--bad); } .event .icon.warn { background: var(--warn-bg); color: var(--warn); } .event .icon.info { background: var(--info-bg); color: var(--info); }
.event .text { font-size: 13px; }
.event .text .sub { display: block; color: var(--muted); font-size: 12px; }
.event time { font-size: 12px; color: var(--muted); white-space: nowrap; }

/* repository health strip */
.strip { display: flex; gap: 28px; flex-wrap: wrap; align-items: center; }
.strip .kv { display: grid; gap: 2px; }
.strip .kv .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.strip .kv .v { font-weight: 600; font-variant-numeric: tabular-nums; }
.strip form { margin-left: auto; }

/* finding page */
.kv-table { table-layout: fixed; }
.kv-table td { word-break: break-word; }
.kv-table td:first-child { color: var(--muted); width: 130px; font-weight: 500; }
.sites { table-layout: fixed; }
.sites td, .sites th { word-break: break-word; }
.c-site { width: 27%; } .c-req { width: 27%; } .c-status { width: 11%; } .c-change { width: 23%; } .c-pr { width: 12%; }
.head .actions .mark-logo { width: 30px; height: 30px; }
.compare { display: grid; grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); gap: 12px; align-items: stretch; }
.side-box { border-radius: 12px; padding: 14px 16px; border: 1px solid var(--line); background: var(--card-2); display: grid; gap: 8px; align-content: start; }
.side-box h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.side-box.expected { border-color: color-mix(in srgb, var(--bad) 35%, var(--line)); }
.side-box.actual { border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.side-box .val { font-family: var(--mono); font-size: 13px; font-weight: 600; word-break: break-word; }
.side-box.expected .val { color: var(--bad); } .side-box.actual .val { color: var(--ok); }
.side-box .cap { font-size: 12px; color: var(--muted); }
.arrow { display: grid; place-items: center; color: var(--muted); }
.arrow svg { width: 20px; height: 20px; }
.diff { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; overflow-x: auto; background: var(--card-2); border-radius: 10px; border: 1px solid var(--line); }
.diff .file { padding: 8px 14px; font-weight: 600; border-bottom: 1px solid var(--line); background: var(--card); font-size: 12.5px; display: flex; justify-content: space-between; gap: 10px; font-family: var(--mono); }
.diff .l { display: block; padding: 0 14px; white-space: pre; }
.diff .add { background: var(--ok-bg); color: var(--ok); }
.diff .del { background: var(--bad-bg); color: var(--bad); }
.diff .hunk { color: var(--info); background: var(--info-bg); padding-top: 2px; padding-bottom: 2px; }
.diff .cut { padding: 6px 14px; color: var(--muted); font-style: italic; }
.run { border-radius: 12px; padding: 14px 16px; border: 1px solid var(--line); display: grid; gap: 6px; align-content: start; }
.run.fail { background: var(--bad-bg); border-color: color-mix(in srgb, var(--bad) 30%, transparent); }
.run.pass { background: var(--ok-bg); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.run.none { color: var(--muted); }
.run .verdict { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.run.fail .verdict { color: var(--bad); } .run.pass .verdict { color: var(--ok); }
.run .verdict svg { width: 18px; height: 18px; }
.run .when { font-size: 12px; color: var(--muted); }
.run details { font-size: 12px; }
.run summary { cursor: pointer; color: var(--fg-2); font-weight: 500; }
.run pre { margin: 8px 0 0; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; color: var(--fg-2); }
.steps { display: grid; }
.step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; padding: 8px 0; align-items: start; }
.step .n { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; font-weight: 700; font-size: 12px; }
.step .n.ok { background: var(--ok-bg); color: var(--ok); }
.step .n.bad { background: var(--bad-bg); color: var(--bad); }

/* sign-in and account picker */
.hero { min-height: 100vh; width: 100%; display: grid; place-items: center; padding: 32px 16px; background: radial-gradient(1200px 600px at 20% -10%, var(--accent-soft), transparent 60%), var(--bg); }
.hero .card { max-width: 460px; width: 100%; padding: 32px; display: grid; gap: 14px; text-align: center; justify-items: center; }
.hero h1 { font-size: 26px; }
.hero .button { width: 100%; justify-content: center; padding: 10px 16px; }
.hero .foot { font-size: 12px; color: var(--muted); }
.accounts { display: grid; gap: 10px; width: 100%; text-align: left; }
.accounts a { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; color: inherit; }
.accounts a:hover { text-decoration: none; border-color: var(--accent); background: var(--card-2); }
.accounts .avatar { width: 34px; height: 34px; border-radius: 9px; background: var(--navy); }
.accounts b { display: block; }
.accounts .meta { margin-left: auto; }

/* shared launch pieces */
.eyebrow { margin: 0 0 6px; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
.hl { background: linear-gradient(90deg, #60a5fa, #a5b4fc); -webkit-background-clip: text; background-clip: text; color: transparent; }
.button.ghost { background: transparent; }
.button.small { padding: 5px 12px; font-size: 12.5px; }
.icon { width: 32px; height: 32px; border-radius: 9px; display: inline-grid; place-items: center; background: var(--card-2); color: var(--muted); flex: none; }
.icon svg { width: 16px; height: 16px; }
.icon.ok { background: var(--ok-bg); color: var(--ok); } .icon.bad { background: var(--bad-bg); color: var(--bad); } .icon.warn { background: var(--warn-bg); color: var(--warn); } .icon.info { background: var(--info-bg); color: var(--info); }
.progress { display: block; width: 100%; height: 8px; border-radius: 999px; overflow: hidden; }
.progress .track { fill: var(--line); } .progress .fill { fill: var(--accent); }

/* value hero */
.value-hero { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 24px; align-items: center; padding: 28px 32px; border-radius: 18px; color: #e8eefc; background: radial-gradient(700px 300px at 85% 0%, rgba(96,165,250,.35), transparent 60%), linear-gradient(135deg, #0b1b3a 0%, #13306b 60%, #1d4ed8 140%); box-shadow: 0 20px 40px -24px rgba(11,27,58,.7); }
.value-hero .eyebrow { color: #93c5fd; }
.value-hero h1 { font-size: 30px; line-height: 1.2; font-weight: 700; letter-spacing: -.02em; color: #fff; max-width: 640px; }
.value-hero .vh-sub { margin: 10px 0 18px; color: #c7d4f0; font-size: 15px; }
.value-hero .button.ghost { color: #fff; border-color: rgba(255,255,255,.35); }
.value-hero .button.ghost:hover { background: rgba(255,255,255,.1); border-color: #fff; }
.value-hero .button svg { width: 15px; height: 15px; }
.vh-ring { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 16px; }
.value-hero .ring .track { stroke: rgba(255,255,255,.14); }
.value-hero .ring .bar.ok { stroke: #4ade80; } .value-hero .ring .bar.warn { stroke: #fbbf24; } .value-hero .ring .bar.bad { stroke: #f87171; }
.value-hero .ring .of, .value-hero .health .why { color: #b6c3e2; }
.value-hero .health .verdict, .value-hero .ring .score { color: #fff; }

/* latest catch */
.catch { display: grid; gap: 14px; align-content: start; }
.even > .column { align-content: stretch; }
.even > .column > .section { grid-template-rows: auto 1fr; }
.even .catch { grid-template-rows: auto auto auto auto auto 1fr; }
.catch-actions { align-self: end; }
.proof { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.proof li { display: grid; gap: 6px; justify-items: start; font-size: 12px; color: var(--muted); padding: 10px 12px; border-radius: 10px; background: var(--card-2); border: 1px solid var(--line); overflow-wrap: anywhere; }
.proof-dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-bg); color: var(--ok); }
.proof-dot svg { width: 13px; height: 13px; }
.catch-head { display: flex; gap: 12px; align-items: center; }
.catch-head .eyebrow { color: var(--muted); text-transform: none; letter-spacing: 0; font-weight: 500; margin-bottom: 2px; }
.catch-head h3 { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.catch-head h3 a { color: var(--fg); }
.catch-flow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.flow-arrow { color: var(--muted); display: inline-grid; } .flow-arrow svg { width: 18px; height: 18px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 10px; font-size: 13px; font-weight: 600; background: var(--card-2); border: 1px solid var(--line); }
.chip svg { width: 15px; height: 15px; }
.chip.fail { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.chip.pass { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.diff.mini .l { white-space: pre-wrap; overflow-wrap: anywhere; }
.catch-why { font-size: 13.5px; }
.empty-catch, .all-clear { display: flex; gap: 12px; align-items: flex-start; }

/* needs your attention */
.todo-list { display: grid; }
.todo { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; gap: 12px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--line); color: var(--fg); transition: background .1s; }
.todo:first-child { border-top: 0; }
.todo:hover { background: var(--card-2); text-decoration: none; }
.todo .text { min-width: 0; font-size: 13px; }
.todo .text b { font-weight: 600; display: block; overflow-wrap: anywhere; }
.todo .sub { display: block; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.todo .go { color: var(--muted); } .todo .go svg { width: 16px; height: 16px; }
.todo.more { grid-template-columns: 1fr auto; color: var(--accent); font-size: 12.5px; font-weight: 500; }

/* first run */
.setup { display: grid; gap: 14px; }
.setup-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.setup-count { font-size: 12.5px; font-weight: 600; color: var(--accent-ink); background: var(--accent-soft); padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.setup-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.setup-steps li { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 10px; }
.setup-steps li.step-active { background: var(--accent-soft); }
.setup-steps .step-dot { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; border: 2px solid var(--line-2); color: var(--muted); }
.setup-steps .step-dot svg { width: 14px; height: 14px; }
.setup-steps .step-done .step-dot { background: var(--ok); border-color: var(--ok); color: #fff; }
.setup-steps .step-active .step-dot { border-color: var(--accent); color: var(--accent); }
.setup-steps .step-done b { color: var(--muted); font-weight: 500; text-decoration: line-through; }
.setup-steps .sub { display: block; font-size: 12px; color: var(--muted); }
.welcome { display: grid; gap: 14px; justify-items: start; padding: 32px; }
.welcome h1 { font-size: 28px; }
.welcome .lead { max-width: 640px; font-size: 15px; }
.mini-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; width: 100%; margin-top: 8px; }
.mini-step { display: grid; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card-2); }
.scanning { display: grid; gap: 14px; padding: 28px 32px; }
.scan-head { display: flex; gap: 16px; align-items: center; }
.scan-head h1 { font-size: 24px; }
.pulse { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.4s ease-out infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,.55); } 100% { box-shadow: 0 0 0 14px rgba(37,99,235,0); } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.scan-list { list-style: none; margin: 0; padding: 0; display: grid; }
.scan-list li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); font-weight: 500; overflow-wrap: anywhere; }

/* landing page */
.landing { flex: 1; min-width: 0; background: var(--bg); }
.lp-inner { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.lp-nav { position: sticky; top: 0; z-index: 5; background: rgba(11,27,58,.92); backdrop-filter: blur(8px); border-bottom: 1px solid rgba(255,255,255,.08); }
.lp-nav .lp-inner { display: flex; align-items: center; gap: 24px; height: 60px; }
.lp-nav nav { display: flex; gap: 20px; margin-left: auto; }
.lp-nav nav a { color: #c3cde6; font-size: 13.5px; font-weight: 500; }
.lp-nav nav a:hover { color: #fff; text-decoration: none; }
.lp-nav .button.small { background: transparent; color: #fff; border-color: rgba(255,255,255,.3); }
.lp-hero { color: #e8eefc; background: radial-gradient(900px 420px at 80% -10%, rgba(96,165,250,.35), transparent 60%), linear-gradient(160deg, #0b1b3a 0%, #102449 55%, #173a86 100%); padding: 72px 0 88px; }
.lp-hero .lp-inner { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, .95fr); gap: 48px; align-items: center; }
.lp-hero .eyebrow { color: #93c5fd; }
.lp-hero h1 { font-size: 48px; line-height: 1.08; letter-spacing: -.03em; font-weight: 750; color: #fff; }
.lp-lead { font-size: 17px; color: #c7d4f0; margin: 18px 0 26px; max-width: 560px; }
.lp-hero .button { padding: 11px 18px; font-size: 14px; }
.lp-hero .button.ghost { color: #fff; border-color: rgba(255,255,255,.35); }
.lp-hero .button.ghost:hover { background: rgba(255,255,255,.1); }
.lp-note { margin-top: 14px; font-size: 13px; color: #9fb0d4; }
.lp-shot { transform: perspective(1400px) rotateY(-6deg) rotateX(2deg); }
.lp-catch { color: var(--fg); box-shadow: 0 40px 80px -30px rgba(0,0,0,.6); }
.lp-stats { background: var(--card); border-bottom: 1px solid var(--line); }
.lp-stats .lp-inner { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding-top: 22px; padding-bottom: 22px; }
.lp-stats div { display: grid; gap: 2px; }
.lp-stats b { font-size: 22px; letter-spacing: -.01em; }
.lp-stats span { color: var(--muted); font-size: 13px; }
.lp-section { padding: 72px 0; }
.lp-section.alt { background: var(--card); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.lp-section h2 { font-size: 30px; letter-spacing: -.02em; margin: 0 0 28px; max-width: 720px; }
.lp-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.lp-step { display: grid; gap: 10px; position: relative; }
.lp-step h3 { font-size: 17px; }
.lp-step-n { position: absolute; top: 14px; right: 18px; font-size: 40px; font-weight: 800; color: var(--line); line-height: 1; }
.lp-providers { display: flex; flex-wrap: wrap; gap: 10px; }
.lp-provider { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px 6px 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--card-2); font-size: 13px; font-weight: 500; }
.lp-provider .mark-logo { border-radius: 50%; }
.lp-proof { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 40px; align-items: center; }
.lp-proof .lead { margin-top: 10px; font-size: 15px; }
.lp-trust { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 32px; margin-bottom: 18px; }
.lp-trust-item { display: flex; gap: 12px; align-items: flex-start; }
.lp-pricing { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; max-width: 860px; }
.price { display: grid; gap: 12px; align-content: start; padding: 26px; }
.price h3 { font-size: 20px; }
.price ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.price li { display: flex; gap: 8px; align-items: center; font-size: 13.5px; }
.price li svg { width: 15px; height: 15px; color: var(--ok); flex: none; }
.price.featured { border: 2px solid var(--accent); }
.price .button { justify-self: start; }
.lp-cta { text-align: center; color: #e8eefc; background: linear-gradient(135deg, #0b1b3a, #1d4ed8); padding: 64px 0; }
.lp-cta h2 { font-size: 32px; color: #fff; letter-spacing: -.02em; }
.lp-cta p { color: #c7d4f0; margin: 10px 0 22px; }
.lp-cta .btn-row { justify-content: center; }
.lp-cta .button.ghost { color: #fff; border-color: rgba(255,255,255,.35); }
.lp-foot { padding: 28px 0 40px; }
.lp-foot .lp-inner { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.lp-foot nav { display: flex; gap: 18px; }
.lp-foot a { color: var(--muted); font-size: 13px; }
.brand-sm { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.brand-sm { color: var(--fg); } .brand-sm svg { display: block; height: 26px; width: auto; }
@media (max-width: 900px) { .lp-shot { transform: none; } .lp-hero { padding: 40px 0 56px; } .lp-section { padding: 48px 0; } .lp-section h2 { font-size: 24px; } .lp-inner { padding: 0 16px; } }

@media (max-width: 1100px) { .overview-top, .cols-3 { grid-template-columns: minmax(0, 1fr); } .cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .span-2 { grid-column: auto; } .value-hero { grid-template-columns: minmax(0, 1fr); } .lp-hero .lp-inner, .lp-proof { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 900px) {
  body { flex-direction: column; }
  .side { position: static; width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; }
  .side .account, .side .foot { display: none; }
  .nav { flex-direction: row; overflow-x: auto; width: 100%; gap: 4px; }
  .nav .group { display: none; }
  .nav a { padding: 7px 10px; white-space: nowrap; }
  .nav a .label { display: none; }
  .main { margin-left: 0; padding: 20px 16px 48px; }
  .proof { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols-2, .cols-4, .compare, .lp-steps, .lp-pricing, .lp-trust, .mini-steps { grid-template-columns: minmax(0, 1fr); }
  .lp-nav nav { display: none; }
  .lp-hero h1 { font-size: 34px; }
  .value-hero h1 { font-size: 24px; }
  .setup-steps li { grid-template-columns: 30px minmax(0, 1fr); }
  .setup-steps li .button { grid-column: 2; justify-self: start; }
  .compare .arrow svg { transform: rotate(90deg); }
  th:nth-child(n+4), td:nth-child(n+4) { display: none; }
  .deadline { grid-template-columns: 58px minmax(0, 1fr); }
  .deadline .hits { display: none; }
}
@media print { .side { display: none; } .main { margin: 0; } }
/* The logo's motion (brand/build_logo.mjs): intro, hover and the in-progress loop. */
${MOTION_CSS}
`;
