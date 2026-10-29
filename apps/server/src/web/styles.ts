/**
 * The one stylesheet, served at /static/app.css. No scripts anywhere: the theme is a cookie read on
 * the server, charts are inline SVG, hover tooltips and motion are CSS. Colors are tokens on :root:
 * Stone and Ink, the same as the website. A stone page, ink type and ink buttons, red only where code
 * breaks, amber for high and coming soon, green only where it's fixed. Headlines in Instrument Serif.
 * Light for everyone, including "auto"; an ink set applies only when the user picks Dark.
 */
const DARK = `
  --bg: #121212; --card: #1a1a1a; --card-2: #161616; --fg: #f1f1ee; --fg-2: #d6d6d0; --muted: #9d9d97; --faint: #74746f; --line: #2a2a2a; --line-2: #3a3a38;
  --accent: #f1f1ee; --accent-2: #d6d6d0; --accent-soft: #242423; --accent-ink: #f1f1ee; --on-accent: #121212;
  --side-bg: #121212; --side-fg: #d6d6d0; --side-muted: #8a8a85; --side-line: #2a2a2a; --side-hover: #222221;
  --edge: #2a2a2a; --band: #0b0b0b; --band-fg: #f1f1ee;
  --ok: #86c9a0; --ok-bg: #1d2b22; --warn: #e3b261; --warn-bg: #2f2717; --bad: #f0786c; --bad-bg: #33201d; --info: #d6d6d0; --info-bg: #242423;
  --shadow: none; --shadow-hover: 0 14px 30px -18px rgba(0,0,0,.6);
  color-scheme: dark;
`;

import { MOTION_CSS } from "./brand";

export const STYLES = `
@font-face { font-family: "Inter Variable"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(/static/inter.woff2) format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: normal; font-weight: 400; font-display: swap; src: url(/static/serif.woff2) format("woff2"); }
@font-face { font-family: "Instrument Serif"; font-style: italic; font-weight: 400; font-display: swap; src: url(/static/serif-italic.woff2) format("woff2"); }
:root {
  --bg: #f1f1ee; --card: #fafaf8; --card-2: #f6f6f3; --fg: #121212; --fg-2: #3e3e3a; --muted: #6b6b66; --faint: #8f8f89; --line: #ddddd7; --line-2: #c9c9c2;
  --accent: #121212; --accent-2: #33332f; --accent-soft: #e4e4df; --accent-ink: #121212; --on-accent: #f1f1ee;
  --side-bg: #f1f1ee; --side-fg: #3e3e3a; --side-muted: #6b6b66; --side-line: #ddddd7; --side-hover: #e4e4df;
  --ok: #3a7350; --ok-bg: #e2ece5; --warn: #875e1c; --warn-bg: #f1e9da; --bad: #ba3628; --bad-bg: #f6e4e1; --info: #3e3e3a; --info-bg: #e4e4df;
  --edge: #ddddd7; --band: #121212; --band-fg: #f1f1ee;
  --shadow: 0 1px 2px rgba(18,18,18,.04);
  --shadow-hover: 0 18px 40px -24px rgba(18,18,18,.35);
  --radius: 16px; --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Consolas, monospace;
  --display: "Instrument Serif", Georgia, "Times New Roman", serif;
  color-scheme: light;
}
:root[data-theme="dark"] {${DARK}}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 "Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", sans-serif; font-feature-settings: "cv11", "ss01"; -webkit-font-smoothing: antialiased; display: flex; min-height: 100vh; }
a { color: var(--fg); text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
h1, h2, h3 { margin: 0; letter-spacing: -.01em; }
h1 { font-family: var(--display); font-size: 38px; font-weight: 400; line-height: 1.05; letter-spacing: -.01em; }
h1 em, h2 em, h3 em { font-style: italic; color: var(--muted); }
h2 { font-size: 15px; font-weight: 500; }
p { margin: 0; }
code, .mono, pre, .diff, .story-code { font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; }
code, .mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.note { font-size: 12.5px; color: var(--muted); }
.lead { color: var(--muted); margin: 6px 0 0; }
.stack { display: grid; gap: 10px; align-content: start; }
.grid > * { min-width: 0; }
.ink-bad { color: var(--bad); } .ink-ok { color: var(--ok); }
.marks { display: flex; gap: 4px; align-items: center; }
.reasons { margin: 6px 0 0; padding-left: 18px; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dim { color: var(--faint); }
.nowrap { white-space: nowrap; }
/* text for screen readers only: the phone menu shows icons, and its links keep their names */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* keyboard focus: one visible ring everywhere; inside clipped lists it is drawn inward */
:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
.todo:focus-visible, .nav a:focus-visible, .filters a:focus-visible, td a:focus-visible { outline-offset: -2px; }
/* on an ink pill (the current page, the chosen filter) the ring is drawn in the page color, inside it */
.nav a.active:focus-visible, .filters a.on:focus-visible { outline-color: var(--on-accent); outline-offset: -4px; }
.skip { position: absolute; left: 12px; top: -48px; z-index: 20; padding: 8px 14px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-weight: 500; text-decoration: none; }
.skip:focus { top: 12px; }

/* sidebar: stone, the active page as an ink pill */
.side { position: fixed; top: 0; bottom: 0; left: 0; width: 240px; background: var(--side-bg); border-right: 1px solid var(--side-line); color: var(--side-fg); display: flex; flex-direction: column; padding: 22px 14px; gap: 20px; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--fg); padding: 2px 10px; text-decoration: none; }
.brand svg { display: block; height: 26px; width: auto; }
.mark { display: inline-grid; flex: none; color: var(--fg); } .mark svg { display: block; width: 44px; height: 44px; }
.mark.big svg { width: 52px; height: 52px; }
.account { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 12px; border: 1px solid var(--side-line); }
.avatar { width: 30px; height: 30px; border-radius: 8px; background: var(--fg); color: var(--bg); display: grid; place-items: center; font-weight: 600; font-size: 12px; flex: none; }
.account .who { min-width: 0; flex: 1; }
.account .who b { display: block; color: var(--fg); font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account .who span { font-size: 11.5px; color: var(--side-muted); }
.account a { color: var(--side-muted); font-size: 12px; text-decoration: none; }
.account a:hover { color: var(--fg); }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav .group { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .2em; color: var(--side-muted); padding: 14px 12px 6px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px; color: var(--side-fg); font-weight: 500; text-decoration: none; transition: background .15s, color .15s; }
.nav a svg { width: 16px; height: 16px; flex: none; opacity: .7; }
.nav a:hover { background: var(--side-hover); color: var(--fg); }
.nav a.active { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.nav a.active .count { color: inherit; }
.nav a.active svg { opacity: 1; }
.nav .count { margin-left: auto; font: 500 11.5px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.nav .count.bad { color: var(--bad); font-weight: 700; }
.side .foot { margin-top: auto; display: grid; gap: 10px; padding-top: 14px; border-top: 1px solid var(--side-line); font-size: 12.5px; color: var(--side-muted); }
.side .foot a { color: var(--side-muted); text-decoration: none; }
.side .foot a:hover { color: var(--fg); }
.signout { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.signout span { color: var(--side-fg); font-weight: 500; }
.signout button { background: transparent; color: var(--side-muted); border: 1px solid var(--side-line); padding: 3px 11px; font-size: 12px; }
.signout button:hover { color: var(--fg); border-color: var(--line-2); background: transparent; }
.theme { display: flex; align-items: center; gap: 6px; }
.theme button { background: transparent; color: var(--side-muted); border: 1px solid var(--side-line); padding: 2px 10px; font-size: 11.5px; }
.theme button:hover { color: var(--fg); background: transparent; }
.theme button.on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }

/* main */
.main { margin-left: 240px; flex: 1; min-width: 0; padding: 36px 44px 80px; }
.wrap { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 26px; }
.wrap > *, .section > * { min-width: 0; }
.column { display: grid; gap: 26px; align-content: start; min-width: 0; }
.crumbs { font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
.crumbs a { color: var(--muted); text-decoration: none; }
.crumbs a:hover { color: var(--fg); }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.head .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.section { display: grid; gap: 12px; }
.section > .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.section > .title .more { font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); text-decoration: none; }
.section > .title .more:hover { color: var(--fg); }
.section > .title .more svg { width: 14px; height: 14px; }

.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 20px 22px; }
/* the columns can be wider than the card (a half-width card, a phone): the table scrolls sideways inside it, never the page */
.card.tight { padding: 0; overflow: hidden; overflow-x: auto; }
a.card { display: block; color: inherit; text-decoration: none; transition: transform .2s, box-shadow .2s, border-color .2s; }
a.card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: var(--line-2); }
.grid { display: grid; gap: 18px; }
.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.span-2 { grid-column: span 2; }

/* stat cards */
.stat { display: grid; gap: 6px; align-content: start; }
.stat .label { font-size: 12.5px; color: var(--muted); font-weight: 500; display: flex; align-items: center; justify-content: space-between; }
.stat .label svg { width: 16px; height: 16px; color: var(--faint); }
.stat .value { font-family: var(--display); font-size: 42px; font-weight: 400; letter-spacing: -.01em; line-height: 1.05; font-variant-numeric: tabular-nums; }
.stat .value.bad { color: var(--bad); }
.stat .value.ok { color: var(--ok); }
.stat .sub { font-size: 12.5px; color: var(--muted); }

/* health ring */
.health { display: grid; justify-items: center; text-align: center; gap: 8px; }
.ring { position: relative; width: 140px; height: 140px; }
.ring svg { width: 140px; height: 140px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 8; stroke-linecap: round; }
.ring .track { stroke: var(--line); }
.ring .bar { stroke: var(--fg); }
.ring .bar.ok { stroke: var(--ok); } .ring .bar.warn { stroke: var(--warn); } .ring .bar.bad { stroke: var(--bad); }
.ring .center { position: absolute; inset: 0; display: grid; place-content: center; }
.ring .score { font-family: var(--display); font-size: 40px; font-weight: 400; line-height: 1; font-variant-numeric: tabular-nums; }
.ring .of { font-size: 11px; color: var(--muted); }
.health .verdict { font-weight: 500; }
.health .why { font-size: 12.5px; color: var(--muted); max-width: 240px; }

/* tags and status */
.tag { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 500; background: var(--accent-soft); color: var(--fg-2); white-space: nowrap; vertical-align: middle; }
.tag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.tag.plain::before { display: none; }
.tag.ok { background: var(--ok-bg); color: var(--ok); }
.tag.warn { background: var(--warn-bg); color: var(--warn); }
.tag.bad { background: var(--bad-bg); color: var(--bad); }
.tag.info { background: var(--info-bg); color: var(--info); }
.tag.sev-critical { background: var(--bad-bg); color: var(--bad); }
.tag.sev-high { background: var(--warn-bg); color: var(--warn); }
.tag.sev-medium { background: var(--info-bg); color: var(--info); }
.tag.sev-low { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px var(--line); }

/* tables */
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 13px 18px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .16em; color: var(--muted); white-space: nowrap; font-weight: 500; background: var(--card); }
tbody tr { transition: background .12s; }
td a { text-decoration: none; }
td a:hover { text-decoration: underline; }
tbody tr:hover { background: var(--card-2); }
tr:last-child td { border-bottom: 0; }
td .sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; }
tr.affected td:first-child { box-shadow: inset 2px 0 0 var(--bad); }
tr.affected { background: color-mix(in srgb, var(--bad-bg) 40%, transparent); }
tr.affected:hover { background: color-mix(in srgb, var(--bad-bg) 70%, transparent); }
tr.exposed td:first-child { box-shadow: inset 2px 0 0 var(--warn); }
.empty { padding: 32px 20px; text-align: center; color: var(--muted); }
.group-head { display: flex; align-items: center; gap: 10px; padding: 13px 18px; background: var(--card-2); border-bottom: 1px solid var(--line); border-top: 1px solid var(--line); font-weight: 500; }
.group-head:first-child { border-top: 0; }
.group-head .meta { margin-left: auto; font-size: 12px; color: var(--muted); font-weight: 400; display: flex; gap: 8px; align-items: center; }

/* buttons and forms: pills, solid ink or a thin line */
button, .button { font: inherit; font-weight: 500; font-size: 13px; padding: 8px 16px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; transition: background .15s, border-color .15s, transform .15s; }
button:hover, .button:hover { border-color: var(--fg); text-decoration: none; }
button svg, .button svg { width: 15px; height: 15px; }
.button.primary, button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.button.primary:hover, button.primary:hover { transform: translateY(-1px); border-color: var(--accent); }
form.inline { display: inline; }
form.settings { display: grid; gap: 16px; }
form.settings label { display: grid; gap: 5px; font-weight: 500; }
form.settings input[type=number], form.settings input[type=url] { font: inherit; padding: 9px 12px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--card); color: var(--fg); }
form.settings input[type=number] { width: 120px; }
form.settings input:focus { border-color: var(--fg); }
form.settings h2:not(:first-of-type) { margin-top: 10px; }
.check { display: flex !important; gap: 10px; align-items: flex-start; font-weight: 500; }
.check input { margin-top: 3px; accent-color: var(--fg); }
.notice { border-left: 2px solid var(--fg); padding: 11px 14px; background: var(--accent-soft); color: var(--fg-2); border-radius: 10px; font-size: 13px; }
.notice.warn { border-color: var(--warn); background: var(--warn-bg); color: var(--warn); }
.filters { display: flex; gap: 6px; flex-wrap: wrap; }
.filters a { padding: 5px 13px; border-radius: 999px; border: 1px solid var(--line); color: var(--fg-2); font-size: 12.5px; font-weight: 500; background: var(--card); text-decoration: none; }
.filters a:hover { border-color: var(--fg); }
.filters a.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.filters a.off { color: var(--muted); border-style: dashed; }

/* deadline timeline (inline SVG) */
.timeline { display: grid; gap: 10px; }
.tl { display: block; width: 100%; height: auto; overflow: visible; }
.tl .zone { opacity: .3; } .tl .zone.bad { fill: var(--bad); } .tl .zone.warn { fill: var(--warn); } .tl .zone.ok { fill: var(--ok); }
.tl .tick { stroke: var(--line-2); stroke-width: 1.5; }
.tl .label { font-size: 11px; fill: var(--muted); }
.tl .label.strong { fill: var(--fg-2); font-weight: 600; }
.tl .dot { stroke: var(--card); stroke-width: 3; transition: r .1s; }
.tl .dot:hover { r: 9; }
.tl .dot.big { stroke-width: 2.5; }
.tl .dot.bad { fill: var(--bad); } .tl .dot.warn { fill: var(--warn); } .tl .dot.ok { fill: var(--ok); }
.tl .count { font-size: 10px; font-weight: 700; fill: var(--bg); pointer-events: none; }
.deadline { display: grid; grid-template-columns: 58px minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.deadline:first-of-type { border-top: 0; }
.deadline .days { text-align: center; border-radius: 12px; padding: 7px 4px; font: 400 18px/1 var(--display); font-variant-numeric: tabular-nums; }
.deadline .days small { display: block; font: 500 9.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; margin-top: 4px; opacity: .85; }
.deadline .days.bad { background: var(--bad-bg); color: var(--bad); } .deadline .days.warn { background: var(--warn-bg); color: var(--warn); } .deadline .days.ok { background: var(--ok-bg); color: var(--ok); }
.deadline .what a { text-decoration: none; }
.deadline .what b { font-weight: 500; }
.deadline .what .sub { font-size: 12px; color: var(--muted); }

/* providers */
.providers { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.provider { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); transition: box-shadow .2s, border-color .2s, transform .2s; color: inherit; text-decoration: none; }
.provider:hover { border-color: var(--line-2); box-shadow: var(--shadow-hover); transform: translateY(-1px); }
.provider .name { font-weight: 500; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider .sub { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.provider .sub.calls { margin-top: 0; padding-left: 14px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: var(--faint); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.mark-logo { width: 38px; height: 38px; flex: none; display: inline-block; vertical-align: middle; }
.mark-logo.sm { width: 24px; height: 24px; }

/* activity */
.feed { display: grid; }
.event { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 12px 0; border-top: 1px solid var(--line); }
.event:first-child { border-top: 0; padding-top: 0; }
.event .icon { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; background: var(--accent-soft); color: var(--muted); }
.event .icon svg { width: 15px; height: 15px; }
.event .icon.ok { background: var(--ok-bg); color: var(--ok); } .event .icon.bad { background: var(--bad-bg); color: var(--bad); } .event .icon.warn { background: var(--warn-bg); color: var(--warn); } .event .icon.info { background: var(--info-bg); color: var(--info); }
.event .text { font-size: 13px; }
.event .text .sub { display: block; color: var(--muted); font-size: 12px; }
.event time { font-size: 12px; color: var(--muted); white-space: nowrap; }

/* repository health strip */
.strip { display: flex; gap: 32px; flex-wrap: wrap; align-items: center; }
.strip .kv { display: grid; gap: 2px; }
.strip .kv .k { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .16em; font-weight: 500; }
.strip .kv .v { font-weight: 500; font-variant-numeric: tabular-nums; }
.strip form { margin-left: auto; }

/* finding page */
.kv-table { table-layout: fixed; }
.kv-table td { word-break: break-word; }
.kv-table td:first-child { color: var(--muted); width: 150px; font-weight: 500; padding-left: 0; }
.kv-table td:last-child { padding-right: 0; }
.sites { table-layout: fixed; }
.sites td, .sites th { word-break: break-word; }
.c-site { width: 27%; } .c-req { width: 27%; } .c-status { width: 11%; } .c-change { width: 23%; } .c-pr { width: 12%; }
.head .actions .mark-logo { width: 30px; height: 30px; }
.compare { display: grid; grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); gap: 12px; align-items: stretch; }
.side-box { border-radius: 14px; padding: 16px 18px; border: 1px solid var(--line); background: var(--card); display: grid; gap: 8px; align-content: start; }
.side-box h3 { font-size: 10.5px; text-transform: uppercase; letter-spacing: .16em; color: var(--muted); font-weight: 500; }
.side-box.expected { background: var(--bad-bg); border-color: transparent; }
.side-box.actual { background: var(--ok-bg); border-color: transparent; }
.side-box .val { font-family: var(--mono); font-size: 13px; font-weight: 500; word-break: break-word; }
.side-box.expected .val { color: var(--bad); } .side-box.actual .val { color: var(--ok); }
.side-box .cap { font-size: 12px; color: var(--muted); }
.arrow { display: grid; place-items: center; color: var(--faint); }
.arrow svg { width: 20px; height: 20px; }
.diff { margin: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.7; overflow-x: auto; background: var(--card); border-radius: 12px; border: 1px solid var(--line); }
.diff .file { padding: 10px 14px; font-weight: 500; border-bottom: 1px solid var(--line); background: var(--card); color: var(--fg-2); font-size: 12.5px; display: flex; justify-content: space-between; gap: 10px; font-family: var(--mono); }
.diff .l { display: block; padding: 0 14px; white-space: pre; }
.diff .add { background: var(--ok-bg); color: var(--ok); }
.diff .del { background: var(--bad-bg); color: var(--bad); }
.diff .hunk { color: var(--muted); background: var(--card-2); padding-top: 2px; padding-bottom: 2px; }
.diff .cut { padding: 6px 14px; color: var(--muted); font-style: italic; }
.run { border-radius: 14px; padding: 16px 18px; border: 1px solid var(--line); display: grid; gap: 6px; align-content: start; }
.run.fail { background: var(--bad-bg); border-color: transparent; }
.run.pass { background: var(--ok-bg); border-color: transparent; }
.run.none { color: var(--muted); }
.run .verdict { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.run.fail .verdict { color: var(--bad); } .run.pass .verdict { color: var(--ok); }
.run .verdict svg { width: 18px; height: 18px; }
.run .when { font-size: 12px; color: var(--muted); }
.run details { font-size: 12px; }
.run summary { cursor: pointer; color: var(--fg-2); font-weight: 500; }
.card.stack > h2:not(:first-child) { margin-top: 12px; }
.run pre { margin: 8px 0 0; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; color: var(--fg-2); }
.steps { display: grid; }
.step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; padding: 8px 0; align-items: start; }
.step .n { width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--fg); display: grid; place-items: center; font: 500 12px var(--mono); }
.step .n.ok { background: var(--ok-bg); color: var(--ok); }
.step .n.bad { background: var(--bad-bg); color: var(--bad); }

/* sign-in and account picker */
.hero { min-height: 100vh; width: 100%; display: grid; place-items: center; padding: 32px 16px; background: var(--bg); }
.hero .card { max-width: 440px; width: 100%; padding: 40px 36px; display: grid; gap: 16px; text-align: center; justify-items: center; }
.hero h1 { font-size: 36px; }
.hero .button { width: 100%; justify-content: center; padding: 11px 16px; }
.hero .foot { font-size: 12px; color: var(--muted); }
.accounts { display: grid; gap: 10px; width: 100%; text-align: left; }
.accounts a { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; color: inherit; text-decoration: none; transition: border-color .15s; }
.accounts a:hover { border-color: var(--fg); }
.accounts .avatar { width: 34px; height: 34px; border-radius: 9px; }
.accounts b { display: block; font-weight: 500; }
.accounts .meta { margin-left: auto; }

/* shared launch pieces */
.eyebrow { margin: 0 0 8px; font-size: 10.5px; font-weight: 500; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
.eyebrow.line { display: flex; align-items: center; gap: 14px; }
.eyebrow.line::before { content: ""; width: 32px; height: 1px; background: currentColor; }
.eyebrow.center { justify-content: center; }
.eyebrow.center::after { content: ""; width: 32px; height: 1px; background: currentColor; }
.button.ghost { background: transparent; }
.button.small { padding: 6px 14px; font-size: 12.5px; }
.icon { width: 32px; height: 32px; border-radius: 10px; display: inline-grid; place-items: center; background: var(--accent-soft); color: var(--muted); flex: none; }
.icon svg { width: 16px; height: 16px; }
.icon.ok { background: var(--ok-bg); color: var(--ok); } .icon.bad { background: var(--bad-bg); color: var(--bad); } .icon.warn { background: var(--warn-bg); color: var(--warn); } .icon.info { background: var(--info-bg); color: var(--info); }
.progress { display: block; width: 100%; height: 6px; border-radius: 999px; overflow: hidden; }
.progress .track { fill: var(--line); } .progress .fill { fill: var(--fg); }

/* the status line at the top of the Overview: one sentence, a dot that breathes */
.value-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 32px; align-items: center; padding: 8px 0 6px; }
.value-hero .eyebrow { margin-bottom: 18px; letter-spacing: .08em; text-transform: none; font-size: 12.5px; color: var(--muted); }
.status { display: flex; align-items: flex-start; gap: 18px; }
.value-hero h1 { font-size: 54px; line-height: 1; max-width: 760px; letter-spacing: -.015em; }
.value-hero .vh-sub { margin: 12px 0 22px; color: var(--muted); font-size: 15px; }
.vh-ring { background: var(--card); border: 1px solid var(--line); box-shadow: var(--shadow); border-radius: var(--radius); padding: 18px 22px; }
.status-dot { position: relative; flex: none; width: 13px; height: 13px; margin-top: 21px; border-radius: 50%; background: var(--ok); }
.status-dot.bad { background: var(--bad); } .status-dot.warn { background: var(--warn); }
.status-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: ring-out 2.4s ease-out infinite; }
@keyframes ring-out { from { transform: scale(1); opacity: .45; } to { transform: scale(2.8); opacity: 0; } }

/* latest catch */
.catch { display: grid; gap: 16px; align-content: start; }
.even > .column { align-content: stretch; }
.even > .column > .section { grid-template-rows: auto 1fr; }
.coming { display: grid; align-content: start; }
.coming .deadline { grid-template-columns: 54px minmax(0, 1fr); padding: 12px 0; }
.coming .deadline:first-child { padding-top: 0; }
.coming .tag { margin-top: 6px; }
.coming-foot { font-size: 12.5px; margin-top: 6px; color: var(--muted); }
.catch-actions { align-self: end; }
.proof { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.proof li { display: grid; gap: 6px; justify-items: start; font-size: 12px; color: var(--muted); padding: 11px 13px; border-radius: 12px; background: var(--card-2); border: 1px solid var(--line); overflow-wrap: anywhere; }
.proof-dot { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-bg); color: var(--ok); }
.proof-dot svg { width: 13px; height: 13px; }
.catch-head { display: flex; gap: 12px; align-items: center; }
.catch-head .eyebrow { text-transform: none; letter-spacing: 0; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.catch-head h3 { font: 400 24px/1.2 var(--display); letter-spacing: -.01em; }
.catch-head h3 a { color: var(--fg); text-decoration: none; }
.catch-flow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.flow-arrow { color: var(--faint); display: inline-grid; } .flow-arrow svg { width: 18px; height: 18px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 500; background: var(--accent-soft); }
.chip svg { width: 14px; height: 14px; }
.chip.fail { background: var(--bad-bg); color: var(--bad); }
.chip.pass { background: var(--ok-bg); color: var(--ok); }
.diff.mini .l { white-space: pre-wrap; overflow-wrap: anywhere; }
.catch-why { font-size: 13.5px; color: var(--fg-2); }
.empty-catch, .all-clear { display: flex; gap: 12px; align-items: flex-start; }
.all-clear b, .empty-catch b { font-weight: 500; }

/* needs your attention */
.todo-list { display: grid; }
.todo { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; gap: 14px; align-items: center; padding: 15px 20px; border-top: 1px solid var(--line); color: var(--fg); text-decoration: none; transition: background .12s; }
.todo:first-child { border-top: 0; }
.todo:hover { background: var(--card-2); }
.todo .text { min-width: 0; font-size: 13.5px; }
.todo .text b { font-weight: 500; display: block; overflow-wrap: anywhere; }
.todo .sub { display: block; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.todo .go { color: var(--faint); transition: transform .15s, color .15s; } .todo .go svg { width: 16px; height: 16px; }
.todo:hover .go { color: var(--fg); transform: translateX(2px); }
.todo.more { grid-template-columns: 1fr auto; color: var(--muted); font-size: 12.5px; font-weight: 500; }
.todo.more svg { width: 16px; height: 16px; }

/* first run */
.setup { display: grid; gap: 14px; }
.setup-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.setup-count { font: 500 11.5px var(--mono); color: var(--fg-2); background: var(--accent-soft); padding: 4px 11px; border-radius: 999px; white-space: nowrap; }
.setup-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.setup-steps li { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 12px; }
.setup-steps li.step-active { background: var(--card-2); box-shadow: inset 0 0 0 1px var(--line); }
.setup-steps .step-dot { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font: 500 12px var(--mono); border: 1px solid var(--line-2); color: var(--muted); }
.setup-steps .step-dot svg { width: 14px; height: 14px; }
.setup-steps .step-done .step-dot { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.setup-steps .step-active .step-dot { border-color: var(--fg); color: var(--fg); }
.setup-steps .step-done b { color: var(--muted); font-weight: 400; text-decoration: line-through; }
.setup-steps b { font-weight: 500; }
.setup-steps .sub { display: block; font-size: 12px; color: var(--muted); }
.welcome { display: grid; gap: 16px; justify-items: start; padding: 40px; }
.welcome h1 { font-size: 46px; }
.welcome .lead { max-width: 640px; font-size: 15px; }
.mini-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; width: 100%; margin-top: 12px; background: var(--line); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.mini-step { display: grid; gap: 6px; padding: 18px; background: var(--card); }
.mini-step b { font: 400 24px var(--display); }
.scanning { display: grid; gap: 16px; padding: 32px 36px; }
.scan-head { display: flex; gap: 18px; align-items: flex-start; }
.scan-head h1 { font-size: 38px; }
.pulse { position: relative; width: 13px; height: 13px; margin-top: 15px; border-radius: 50%; background: var(--fg); flex: none; }
.pulse::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: ring-out 1.8s ease-out infinite; }
.scan-list { list-style: none; margin: 0; padding: 0; display: grid; }
.scan-list li { display: flex; justify-content: space-between; gap: 12px; padding: 11px 0; border-top: 1px solid var(--line); font-weight: 500; overflow-wrap: anywhere; }

/* page headings across the app */
.head h1 { font-size: 40px; }

/* ---------- landing page ---------- */
.landing { flex: 1; min-width: 0; background: var(--bg); overflow-x: clip; }
.lp-progress { display: none; }
.lp-inner { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.lp-nav { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.lp-nav .lp-inner { display: flex; align-items: center; gap: 24px; height: 68px; }
.lp-nav nav { display: flex; gap: 26px; margin-left: auto; }
.lp-nav nav a { color: var(--fg-2); font-size: 14px; text-decoration: none; }
.lp-nav nav a:hover { color: var(--fg); }
.lp-nav .btn-row { margin-left: 8px; flex-wrap: nowrap; }
.lp-hero { padding: 92px 0 72px; }
.lp-hero .lp-inner { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 56px; align-items: center; }
.lp-hero h1 { font-size: 84px; line-height: .95; letter-spacing: -.02em; margin-top: 22px; }
.lp-hero h1 em { display: block; }
.lp-lead { font-size: 18px; color: var(--fg-2); margin: 24px 0 32px; max-width: 520px; line-height: 1.6; }
.lp-hero .button { padding: 13px 24px; font-size: 15px; }
.lp-note { margin-top: 16px; font-size: 13px; color: var(--muted); }
.rise { animation: rise .9s cubic-bezier(.2,.8,.2,1) both; }
.rise.d2 { animation-delay: .15s; }
@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

/* the story card: GitHub changes, line 15 breaks, SHAPI fixes it. A 14 s CSS loop, no script. */
.story { background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; box-shadow: 0 40px 80px -44px rgba(0,0,0,.45); }
.story-bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.story-bar .file { font: 12.5px var(--mono); color: var(--fg-2); }
.stack-cell { display: grid; }
.stack-cell > * { grid-area: 1 / 1; }
.story-code { font: 13.5px/1.95 var(--mono); font-variant-ligatures: none; padding: 16px 0; color: var(--muted); margin: 0; }
.story-code .ln { display: grid; grid-template-columns: 44px minmax(0, 1fr); padding-right: 18px; white-space: pre; }
.story-code .ln > .no { color: var(--line-2); text-align: right; padding-right: 16px; user-select: none; }
.story-code .k { color: var(--fg); }
.story-code .hot .txt { color: var(--fg); overflow: hidden; }
.story-code .hot { animation: st-line 14s linear infinite; }
.story-code .before { animation: st-before 14s linear infinite; }
.story-code .after { opacity: 0; animation: st-after 14s linear infinite, st-type 14s steps(39, end) infinite; }
.story-event { margin: 0 18px 16px; padding: 12px 14px; border-radius: 12px; background: var(--card-2); font-size: 13px; color: var(--muted); min-height: 64px; }
.story-event p { display: flex; gap: 10px; align-items: flex-start; opacity: 0; }
.story-event p b { color: var(--fg); font-weight: 500; }
.story-event p i { flex: none; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--faint); }
.story-event .s2 i { background: var(--warn); } .story-event .s3 i { background: var(--bad); } .story-event .s4 i { background: var(--ok); }
.story-badges .tag { opacity: 0; justify-self: end; }
.story .s1 { animation: st-1 14s linear infinite; } .story .s2 { animation: st-2 14s linear infinite; }
.story .s3 { animation: st-3 14s linear infinite; } .story .s4 { animation: st-4 14s linear infinite; }
.story-progress { height: 2px; margin: 0 18px 18px; background: var(--line); border-radius: 2px; overflow: hidden; }
.story-progress i { display: block; height: 100%; background: var(--fg); transform-origin: left; animation: st-progress 14s linear infinite; }
@keyframes st-1 { 0%, 22% { opacity: 1; } 24%, 98% { opacity: 0; } 100% { opacity: 1; } }
@keyframes st-2 { 0%, 23% { opacity: 0; } 25%, 42% { opacity: 1; } 44%, 100% { opacity: 0; } }
@keyframes st-3 { 0%, 43% { opacity: 0; } 45%, 61% { opacity: 1; } 63%, 100% { opacity: 0; } }
@keyframes st-4 { 0%, 62% { opacity: 0; } 64%, 96% { opacity: 1; } 98%, 100% { opacity: 0; } }
@keyframes st-line { 0%, 44% { background: transparent; } 45%, 62% { background: var(--bad-bg); } 64%, 96% { background: var(--ok-bg); } 98%, 100% { background: transparent; } }
@keyframes st-before { 0%, 62% { opacity: 1; } 63%, 98% { opacity: 0; } 100% { opacity: 1; } }
@keyframes st-after { 0%, 62% { opacity: 0; } 63%, 97% { opacity: 1; } 98%, 100% { opacity: 0; } }
@keyframes st-type { 0%, 63% { clip-path: inset(0 100% 0 0); } 78%, 100% { clip-path: inset(0 0 0 0); } }
@keyframes st-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }

/* the APIs SHAPI recognizes, drifting by */
.lp-ticker { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); overflow: hidden; white-space: nowrap; padding: 15px 0; }
.lp-ticker .track { display: inline-flex; gap: 44px; padding-left: 44px; animation: drift 70s linear infinite; }
.lp-ticker:hover .track { animation-play-state: paused; }
.lp-ticker span { display: inline-flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 500; color: var(--fg-2); }
@keyframes drift { to { transform: translateX(-50%); } }

.lp-stats .lp-inner { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding-top: 40px; padding-bottom: 8px; }
.lp-stats div { display: grid; gap: 2px; }
.lp-stats b { font: 400 40px var(--display); letter-spacing: -.01em; }
.lp-stats span { color: var(--muted); font-size: 13px; }
.lp-section { padding: 110px 0; }
.lp-section.alt { background: var(--card-2); }
.lp-section h2 { font: 400 56px/1 var(--display); letter-spacing: -.015em; margin: 18px 0 40px; max-width: 780px; }
.lp-section h2 .dim { font-style: italic; color: var(--muted); }
.lp-section.centered .lp-inner > .eyebrow, .lp-section.centered .lp-inner > h2 { text-align: center; margin-left: auto; margin-right: auto; }
.lp-problems { max-width: 760px; margin: 0 auto; }
.lp-problem { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 8px; padding: 36px 0; border-top: 1px solid var(--line-2); }
.lp-problem .n { font: 400 36px var(--display); color: var(--muted); }
.lp-problem h3 { font: 400 34px/1.15 var(--display); letter-spacing: -.01em; margin: 0 0 10px; }
.lp-problem p { color: var(--muted); max-width: 560px; }
.red { color: var(--bad); }
.lp-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; box-shadow: 0 40px 80px -50px rgba(0,0,0,.35); }
.lp-step { background: var(--card); padding: 30px 26px 34px; transition: background .25s; }
.lp-step:hover { background: var(--accent-soft); }
.lp-step-n { font: 600 12.5px var(--mono); color: var(--muted); }
.lp-step h3 { font: 400 32px var(--display); letter-spacing: -.01em; margin: 16px 0 10px; }
.lp-step p { font-size: 14px; color: var(--muted); }
.lp-providers { display: flex; flex-wrap: wrap; gap: 10px; }
.lp-provider { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px 6px 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); font-size: 13px; }
.lp-provider .mark-logo { border-radius: 50%; }
.lp-proof { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; align-items: center; }
.lp-proof h2 { margin-bottom: 20px; }
.lp-proof .lead { margin-top: 12px; font-size: 15px; }
.lp-trust { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 26px 40px; margin-bottom: 22px; }
.lp-trust-item { display: flex; gap: 14px; align-items: flex-start; }
.lp-trust-item b { font-weight: 500; }
.lp-pricing { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; max-width: 880px; }
.price { display: flex; flex-direction: column; gap: 14px; padding: 30px; }
.price h3 { font: 400 32px var(--display); }
.price ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; }
.price li { display: flex; gap: 9px; align-items: center; font-size: 13.5px; }
.price li svg { width: 15px; height: 15px; color: var(--ok); flex: none; }
.price.featured { border-color: var(--fg); }
.price .button { align-self: flex-start; margin-top: auto; }
.lp-cta { text-align: center; padding: 140px 0 150px; border-top: 1px solid var(--line); }
.lp-cta h2 { font: 400 88px/.95 var(--display); letter-spacing: -.02em; }
.lp-cta h2 em { font-style: italic; color: var(--muted); }
.lp-cta p { color: var(--muted); margin: 18px 0 30px; font-size: 16px; }
.lp-cta .btn-row { justify-content: center; }
.lp-cta .button { padding: 11px 22px; font-size: 14px; }
.lp-foot { padding: 28px 0 40px; }
.lp-foot .lp-inner { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.lp-foot nav { display: flex; gap: 20px; }
.lp-foot a { color: var(--muted); font-size: 13px; text-decoration: none; }
.lp-foot a:hover { color: var(--fg); }
.brand-sm { display: flex; align-items: center; gap: 8px; color: var(--fg); } .brand-sm svg { display: block; height: 24px; width: auto; }

@media (max-width: 1100px) { .cols-3 { grid-template-columns: minmax(0, 1fr); } .span-2 { grid-column: auto; } .lp-hero .lp-inner, .lp-proof { grid-template-columns: minmax(0, 1fr); } .lp-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  body { flex-direction: column; }
  .side { position: static; width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--side-line); }
  .side .account { margin-left: auto; padding: 4px 6px; border: 0; gap: 8px; }
  .side .account .avatar { width: 24px; height: 24px; font-size: 10.5px; border-radius: 7px; }
  .side .account .who span { display: none; }
  .side .foot { width: 100%; margin-top: 0; padding-top: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
  .side .foot .signout { gap: 10px; }
  .nav { flex-direction: row; overflow-x: auto; width: 100%; gap: 4px; }
  .nav .group { display: none; }
  .nav a { padding: 7px 10px; white-space: nowrap; }
  .nav a .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .nav a { position: relative; }
  .main { margin-left: 0; padding: 24px 16px 56px; }
  .proof { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols-2, .compare, .lp-pricing, .lp-trust, .mini-steps { grid-template-columns: minmax(0, 1fr); }
  .lp-nav nav { display: none; }
  .lp-nav .btn-row { margin-left: auto; }
  .lp-inner { padding: 0 16px; }
  .lp-hero { padding: 48px 0 56px; }
  .lp-hero h1 { font-size: 52px; }
  .lp-section { padding: 72px 0; }
  .lp-section h2 { font-size: 38px; }
  .lp-cta h2 { font-size: 52px; }
  .lp-problem { grid-template-columns: minmax(0, 1fr); }
  .lp-problem h3 { font-size: 28px; }
  .value-hero { grid-template-columns: minmax(0, 1fr); }
  .value-hero h1 { font-size: 36px; }
  .status-dot { margin-top: 13px; }
  .head h1, h1 { font-size: 32px; }
  .setup-steps li { grid-template-columns: 30px minmax(0, 1fr); }
  .setup-steps li .button { grid-column: 2; justify-self: start; }
  .compare .arrow svg { transform: rotate(90deg); }
  th:nth-child(n+4), td:nth-child(n+4) { display: none; }
  /* with the last columns hidden, the fixed widths of the call sites table would leave it a third empty */
  .sites { table-layout: auto; }
  .sites col { width: auto; }
  th, td { padding: 12px 12px; }
  .deadline { grid-template-columns: 58px minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .lp-steps { grid-template-columns: minmax(0, 1fr); }
  .lp-nav .btn-row .ghost { display: none; }
  .story-code { font-size: 11.5px; }
  .story-code .ln { grid-template-columns: 30px minmax(0, 1fr); }
  .story-code .ln > .no { padding-right: 10px; }
}
/* Scroll-driven motion on the landing: CSS scroll timelines, no script. Browsers without them, and
   visitors who ask for less motion, get the page as it is above. .landing uses overflow-x: clip, not
   hidden, so it is not a scroll container and every view() timeline follows the page. */
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    /* reading progress: a thin ink line under the top edge */
    .lp-progress { display: block; position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 6; background: var(--fg); transform-origin: left; animation: sc-grow linear both; animation-timeline: scroll(root); }

    /* hero: as it leaves, the words drift up and soften, the card settles back */
    .lp-hero h1, .lp-hero .lp-lead { animation: sc-drift linear both; animation-timeline: view(); animation-range: exit 0% exit 100%; }
    .lp-hero .story { animation: sc-settle linear both; animation-timeline: view(); animation-range: exit 0% exit 100%; }

    /* the provider strip slides against its own drift while it crosses the screen */
    .lp-ticker .track { animation-name: drift, sc-slide; animation-duration: 70s, auto; animation-timing-function: linear, linear; animation-iteration-count: infinite, 1; animation-fill-mode: none, both; animation-timeline: auto, view(); animation-range: normal, cover 0% cover 100%; }

    /* headlines rise in; the grey second line inks in as it reaches the middle */
    .lp-section .lp-inner > .eyebrow, .lp-section .lp-inner > h2, .lp-proof h2, .lp-cta h2, .lp-stats .lp-inner > div { animation: sc-rise linear both; animation-timeline: view(); animation-range: entry 10% cover 30%; }
    .lp-section h2 .dim { animation: sc-ink linear both; animation-timeline: view(); animation-range: cover 15% cover 45%; }
    .lp-stats .lp-inner > div:nth-child(2) { animation-range: entry 20% cover 34%; }
    .lp-stats .lp-inner > div:nth-child(3) { animation-range: entry 30% cover 38%; }
    .lp-stats .lp-inner > div:nth-child(4) { animation-range: entry 40% cover 42%; }

    /* the problem, one by one: the number slides in, then the line, then the reason */
    .lp-problem { animation: sc-rule linear both; animation-timeline: view(); animation-range: entry 0% cover 30%; }
    .lp-problem .n { animation: sc-from-left linear both; animation-timeline: view(); animation-range: entry 10% cover 25%; }
    .lp-problem h3 { animation: sc-rise linear both; animation-timeline: view(); animation-range: entry 25% cover 32%; }
    .lp-problem p { animation: sc-rise linear both; animation-timeline: view(); animation-range: entry 40% cover 38%; }
    /* "production." turns red as it reaches the middle of the screen */
    .lp-problem .red { animation: sc-red linear both; animation-timeline: view(); animation-range: cover 30% cover 50%; }

    /* the four steps come in one after the other; their content moves, not the cells, so the grid's
       lines never open up. Stacked on a phone, each step simply rises as it arrives. */
    .lp-step > * { animation: sc-step linear both; animation-timeline: view(); animation-range: entry 0% entry 80%; }
    .lp-step:nth-child(2) > * { animation-range: entry 15% entry 95%; }
    .lp-step:nth-child(3) > * { animation-range: entry 30% cover 25%; }
    .lp-step:nth-child(4) > * { animation-range: entry 45% cover 32%; }
    @media (max-width: 560px) { .lp-step:nth-child(n) > * { animation-range: entry 0% entry 80%; } }

    /* provider pills fan in */
    .lp-providers { animation: sc-spread linear both; animation-timeline: view(); animation-range: entry 0% cover 35%; }

    /* the proof: scroll through the diff and the fix writes itself over the break. The diff scrolls
       sideways (overflow-x: auto), so its lines follow a timeline named on the diff, not their own view(). */
    .lp-scrub { view-timeline: --sc-fix block; }
    .lp-scrub .del { animation: sc-strike linear both; animation-timeline: --sc-fix; animation-range: cover 25% cover 45%; }
    .lp-scrub .add { animation: sc-write linear both; animation-timeline: --sc-fix; animation-range: cover 35% cover 60%; }

    /* cards and the closing line */
    .lp-trust-item, .lp-pricing .card { animation: sc-rise linear both; animation-timeline: view(); animation-range: entry 5% cover 30%; }
    .lp-trust-item:nth-child(even), .lp-pricing .card:nth-child(2) { animation-range: entry 20% cover 36%; }
    .lp-cta h2 { animation-name: sc-close; animation-range: entry 0% cover 45%; }
  }
}
@keyframes sc-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sc-drift { to { transform: translateY(-70px); opacity: .25; } }
@keyframes sc-settle { to { transform: translateY(40px) scale(.94); opacity: .5; } }
@keyframes sc-slide { from { translate: 12% 0; } to { translate: -12% 0; } }
@keyframes sc-rise { from { opacity: 0; transform: translateY(36px); } to { opacity: 1; transform: none; } }
@keyframes sc-ink { from { color: var(--line-2); } to { color: var(--muted); } }
@keyframes sc-rule { from { border-top-color: transparent; } to { border-top-color: var(--line-2); } }
@keyframes sc-from-left { from { opacity: 0; transform: translateX(-40px); } to { opacity: 1; transform: none; } }
@keyframes sc-red { from { color: var(--fg); } to { color: var(--bad); } }
@keyframes sc-step { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
@keyframes sc-spread { from { opacity: 0; letter-spacing: -.02em; transform: scale(.96); } to { opacity: 1; letter-spacing: normal; transform: none; } }
@keyframes sc-strike { from { opacity: 1; text-decoration: none; } to { opacity: .45; text-decoration: line-through; } }
@keyframes sc-write { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
@keyframes sc-close { from { opacity: 0; transform: scale(.92); letter-spacing: .02em; } to { opacity: 1; transform: none; letter-spacing: -.01em; } }
@media (prefers-reduced-motion: reduce) {
  .rise, .status-dot::after, .pulse::after, .lp-ticker .track, .story-progress i { animation: none; }
  .story .s1, .story .s2, .story .s3, .story-code .before, .story-code .hot, .story-code .after { animation: none; }
  .story .s4, .story-code .after { opacity: 1; animation: none; }
  .story .s1, .story .s2, .story .s3, .story-code .before { opacity: 0; }
  .story-code .hot { background: var(--ok-bg); }
  .story-progress i { transform: none; }
}
@media print { .side { display: none; } .main { margin: 0; } }
/* The logo's motion (brand/build_logo.mjs): intro, hover and the in-progress loop. */
${MOTION_CSS}
`;
