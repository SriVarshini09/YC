// The brand sheet: one self-contained page with every asset, built from build_logo.mjs's drawings.
export function brandSheet(h) {
  const { INK, PAPER, CUT, GAP, LEFT, RIGHT, CLEAR, PIXEL, LAYOUT, art, svgFile, pixelSvg, iconSvg, bannerSvg, ogSvg, animatableSvg, MOTION_CSS, markPaths, f2 } = h;
  const H = LAYOUT.horizontal;
  const b = H.box;
  const vb = `${f2(b.x)} ${f2(b.y)} ${f2(b.w)} ${f2(b.h)}`;
  const k = H.mark.side / CUT;
  const markG = (inner, extra = "") => `<g transform="translate(${f2(H.mark.x)} ${f2(H.mark.y)}) scale(${f2(k)})${extra}">${inner}</g>`;
  const wordG = (fill, bar = H.word.bar) => `<path d="${H.word.d}" fill="${fill}"/><rect x="${f2(bar.x)}" y="${f2(bar.y)}" width="${f2(bar.w)}" height="${f2(bar.h)}" fill="${fill}"/>`;
  const lock = (inner, view = vb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" role="img" aria-label="shapi">${inner}</svg>`;

  // ---- Construction drawing: the mark on its 76-unit grid ----
  const grid = Array.from({ length: CUT / 4 + 1 }, (_, i) => i * 4)
    .map((v) => `<path d="M${v} 0 V${CUT} M0 ${v} H${CUT}" stroke="#9a9a92" stroke-width="${v % 19 === 0 ? 0.35 : 0.15}"/>`)
    .join("");
  const construction = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -8 96 92" class="construction">
<g opacity=".9">${markPaths("#d9d8d0")}</g>${grid}
<path d="M52 0 C52 38 32 38 32 76" fill="none" stroke="${INK}" stroke-width=".5" stroke-dasharray="1.5 1.2"/>
<path d="M48 0 C48 40 28 36 28 76 M56 0 C56 40 36 36 36 76" fill="none" stroke="${INK}" stroke-width=".6"/>
<rect x="0" y="0" width="76" height="76" fill="none" stroke="${INK}" stroke-width=".6"/>
<text x="38" y="-3" font-size="3.2" text-anchor="middle" fill="#55554f">76 units</text>
<text x="52" y="84" font-size="3.2" text-anchor="middle" fill="#55554f">cut ${GAP} wide, centre C52,0 52,38 32,38 32,76</text>
</svg>`;

  // ---- Clear space ----
  const pad = CLEAR * H.mark.side;
  const clear = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f2(b.x - pad - 4)} ${f2(b.y - pad - 4)} ${f2(b.w + 2 * pad + 8)} ${f2(b.h + 2 * pad + 8)}" class="clear">
<rect x="${f2(b.x - pad)}" y="${f2(b.y - pad)}" width="${f2(b.w + 2 * pad)}" height="${f2(b.h + 2 * pad)}" fill="#efeee8" stroke="#9a9a92" stroke-width=".6" stroke-dasharray="2 1.5"/>
<rect x="${f2(b.x)}" y="${f2(b.y)}" width="${f2(b.w)}" height="${f2(b.h)}" fill="none" stroke="#c6c5bc" stroke-width=".4"/>
${art(H, INK)}
<path d="M${f2(b.x - pad)} ${f2(b.y + b.h / 2)} H${f2(b.x)}" stroke="#55554f" stroke-width=".5"/>
<text x="${f2(b.x - pad / 2)}" y="${f2(b.y + b.h / 2 - 2)}" font-size="4" text-anchor="middle" fill="#55554f">½ mark</text>
</svg>`;

  // ---- Don'ts ----
  const g = H.word.glyphs;
  const shBar = { x: g[0].x, y: H.word.bar.y, w: g[1].x + g[1].w - g[0].x, h: H.word.bar.h };
  const donts = [
    ["Don't close the cut", markG(`<rect width="${CUT}" height="${CUT}" fill="${INK}"/>`) + wordG(INK)],
    ["Don't colour the pieces apart", markG(`<path d="${LEFT}" fill="${INK}"/><path d="${RIGHT}" fill="#2F6BFF"/>`) + wordG(INK)],
    ["Don't add gradients or effects", `<defs><linearGradient id="dg" x1="0" x2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>` + markG(markPaths("url(#dg)")) + wordG("url(#dg)")],
    ["Don't rotate or skew the mark", markG(markPaths(INK), ` rotate(14 38 38)`) + wordG(INK)],
    ["Don't move the bar", markG(markPaths(INK)) + wordG(INK, shBar)],
    ["Don't stretch it", `<g transform="scale(1.35 1)">${art(H, INK)}</g>`],
  ];
  const dontView = `${f2(b.x - 6)} ${f2(b.y - 10)} ${f2(b.w * 1.4 + 12)} ${f2(b.h + 20)}`;

  // ---- Small sizes ----
  const smalls = PIXEL.map((p) => `<figure class="px">
<div class="px-row"><span class="label">Hand-drawn</span>${pixelSvg(p, INK).replace("<svg ", `<svg class="real" `)}<span class="dk">${pixelSvg(p, PAPER).replace("<svg ", `<svg class="real" `)}</span></div>
<div class="px-row"><span class="label">Scaled</span>${svgFile(LAYOUT.mark, INK, { height: p.n }).replace("<svg ", `<svg class="real" `)}<span class="dk">${svgFile(LAYOUT.mark, PAPER, { height: p.n }).replace("<svg ", `<svg class="real" `)}</span></div>
${pixelSvg(p, INK).replace("<svg ", `<svg class="zoom" style="width:${p.n * 6}px;height:${p.n * 6}px" `)}
<figcaption>${p.n} px · cut ${p.gap} px, snapped per row</figcaption></figure>`).join("");

  const lockups = [
    ["Mark", LAYOUT.mark],
    ["Wordmark", LAYOUT.wordmark],
    ["Horizontal", LAYOUT.horizontal],
    ["Stacked", LAYOUT.stacked],
  ].map(([name, L]) => `<figure class="lk"><div class="pane light">${svgFile(L, INK)}</div><div class="pane dark">${svgFile(L, PAPER)}</div><figcaption>${name}</figcaption></figure>`).join("");

  const pixel16 = (fill) => pixelSvg(PIXEL[0], fill);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SHAPI brand sheet</title>
<style>
:root { --ink: ${INK}; --paper: ${PAPER}; --muted: #66665f; --line: #e2e1da; --wash: #ecebe5; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--wash); color: var(--ink); font: 15px/1.55 Inter, system-ui, sans-serif; padding: 28px 16px 72px; }
main { max-width: 1080px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
section { background: #fff; border-radius: 14px; padding: 24px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; min-width: 0; }
section * { min-width: 0; }
h1 { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0; font-weight: 600; }
h2 { font-size: 18px; margin: 0; }
p { margin: 0; max-width: 780px; color: #33332e; }
.note { font-size: 13px; color: var(--muted); }
figure { margin: 0; }
figcaption { font-size: 13px; color: var(--muted); margin-top: 6px; }
.hero { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pane { border-radius: 10px; padding: 26px 22px; display: flex; align-items: center; justify-content: center; min-height: 120px; }
.pane.light { background: var(--paper); color: var(--ink); border: 1px solid var(--line); }
.pane.dark { background: var(--ink); color: var(--paper); }
.hero .pane { min-height: 200px; }
.hero .sp-logo { height: 96px; width: auto; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.swatch { border-radius: 10px; padding: 18px; min-height: 120px; display: flex; flex-direction: column; justify-content: flex-end; font-size: 14px; }
.swatch b { font-size: 16px; }
.lk .pane svg { height: 56px; width: auto; }
.lk { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.lk figcaption { grid-column: 1 / -1; margin: 0; }
.construction { width: 100%; max-width: 420px; display: block; }
.clear { width: 100%; max-width: 520px; display: block; }
.px { display: grid; gap: 8px; justify-items: start; }
.px-row { display: flex; align-items: center; gap: 12px; }
.px-row .label { font-size: 12px; color: var(--muted); width: 78px; }
.px-row .dk { background: var(--ink); padding: 4px; border-radius: 4px; display: inline-flex; }
.px svg.real { display: block; width: auto; }
.px svg.zoom { image-rendering: pixelated; background: repeating-conic-gradient(#f1f0ea 0 25%, #fff 0 50%) 0 0 / 12px 12px; }
.mock { border-radius: 12px; overflow: hidden; }
.tabs { display: flex; gap: 0; padding: 8px 10px 0; }
.tabs.light { background: #dfe3e8; } .tabs.dark { background: #202124; }
.tab { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 8px 8px 0 0; font-size: 12.5px; min-width: 210px; }
.tabs.light .tab.on { background: #fff; color: #1f1f1f; } .tabs.dark .tab.on { background: #35363a; color: #e8eaed; }
.tabs .tab:not(.on) { opacity: .65; }
.tabs .tab:not(.on) { color: inherit; }
.tabs.dark .tab:not(.on) { color: #bdc1c6; }
.tab svg { width: 16px; height: 16px; flex: none; }
.addr { padding: 8px 12px; font-size: 12px; }
.tabs.light + .addr { background: #fff; color: #555; border-bottom: 1px solid #e5e5e5; }
.tabs.dark + .addr { background: #35363a; color: #bdc1c6; }
.xprofile { display: flex; align-items: center; gap: 14px; padding: 18px; background: #fff; border: 1px solid var(--line); border-radius: 12px; }
.xprofile .av { width: 88px; height: 88px; border-radius: 50%; overflow: hidden; flex: none; }
.xprofile .av svg, .xprofile .av2 svg { width: 100%; height: 100%; display: block; }
.xprofile .av2 { width: 36px; height: 36px; border-radius: 50%; overflow: hidden; flex: none; }
.xprofile b { display: block; } .xprofile span { color: var(--muted); font-size: 13px; }
.slide { aspect-ratio: 16 / 9; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 6% 7%; display: flex; flex-direction: column; justify-content: space-between; }
.slide svg { height: 26px; width: auto; }
.slide .t { font-size: clamp(20px, 3.2vw, 34px); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; }
.slide .s { color: var(--muted); font-size: 14px; }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.card { aspect-ratio: 3.5 / 2; border-radius: 10px; padding: 7%; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 6px 18px rgba(0,0,0,.06); }
.card.front { background: var(--ink); align-items: center; justify-content: center; }
.card.front svg { width: 34%; height: auto; }
.card.back { background: var(--paper); color: var(--ink); }
.card.back svg { height: 24px; width: auto; }
.card.back .who b { display: block; font-size: 15px; } .card.back .who span { font-size: 12.5px; color: var(--muted); }
.site { background: var(--ink); color: var(--paper); border-radius: 12px; overflow: hidden; }
.site header { display: flex; align-items: center; justify-content: space-between; padding: 16px 22px; border-bottom: 1px solid #23252b; }
.site header a { color: inherit; display: inline-flex; }
.site header .sp-logo { height: 30px; width: auto; }
.site nav { display: flex; gap: 18px; font-size: 13.5px; opacity: .78; align-items: center; }
.site .cta { background: var(--paper); color: var(--ink); padding: 7px 14px; border-radius: 999px; font-weight: 600; opacity: 1; }
.site .body { padding: 44px 22px 52px; }
.site .body .t { font-size: 34px; font-weight: 600; letter-spacing: -.02em; }
.site .body p { color: #b9b8b0; }
.social { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.social svg { width: 100%; height: auto; display: block; border-radius: 8px; }
.social .sq svg { width: 160px; }
.dont svg { width: 100%; height: auto; display: block; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.dont figcaption { color: #8a2d1f; font-weight: 600; }
.motion { display: grid; gap: 10px; }
.motion .pane .sp-logo { height: 56px; width: auto; }
.status { display: flex; align-items: center; gap: 14px; font-size: 14px; }
.status .sp-logo { height: 24px !important; }
button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line); background: #fff; cursor: pointer; justify-self: start; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; border-top: 0; }
code { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: #f3f2ec; padding: 1px 5px; border-radius: 4px; }
ul.check { margin: 0; padding-left: 20px; }
@media (max-width: 760px) { .hero, .grid2, .grid3, .cards, .social, .lk { grid-template-columns: 1fr; } section { padding: 18px; } .tab { min-width: 0; } }
${MOTION_CSS}
</style></head>
<body><main>

<section>
<h1>SHAPI brand sheet</h1>
<div class="hero" id="hero"><div class="pane light">${animatableSvg("currentColor", "sp-join")}</div><div class="pane dark">${animatableSvg("currentColor", "sp-join")}</div></div>
<button type="button" id="replay">Replay the intro</button>
<p>A square cut in two by one curve: your code on the left, the API on the right, two pieces that still fit. Beside it, the name in Inter SemiBold with a bar under <b>api</b>: the API side, held. That is the product in one picture. SHAPI finds where an API's shape stopped fitting your code, and keeps it in place with a tested fix.</p>
</section>

<section>
<h2>Colour</h2>
<div class="grid2">
<div class="swatch" style="background:${INK};color:${PAPER}"><b>Ink</b>${INK}</div>
<div class="swatch" style="background:${PAPER};color:${INK};border:1px solid var(--line)"><b>Paper</b>${PAPER}</div>
</div>
<p class="note">One dark, one light, and nothing else. The mark also works in pure black and pure white. No accent colour, no gradients.</p>
</section>

<section>
<h2>Type</h2>
<p>The wordmark is <b>Inter SemiBold</b>, lowercase, letter-spacing −1.5%, converted to outlines with Inter's own kerning so it never depends on an installed font. Inter is free under the SIL Open Font License; the licence is in <code>brand/fonts/Inter-OFL.txt</code>. Use Inter for any text set beside the logo.</p>
</section>

<section>
<h2>Construction</h2>
<div class="grid2">
<figure>${construction}<figcaption>The mark on a 76-unit square. The cut is ${GAP} units wide along one cubic curve; both pieces are its two edges.</figcaption></figure>
<div style="display:grid;gap:10px;align-content:start">
<p>Every shape is stored as numbers in <code>brand/build_logo.mjs</code>: the square, the curve, the cut width, the font size, the bar's position (12 units below the baseline, 6 units tall, from the a to the end of the i), and the gap between mark and word (16 units).</p>
<p>In the horizontal lockup, the mark is exactly as tall as the h: its top meets the ascender and its foot sits on the baseline.</p>
<p class="note">Optical corrections: below 48 px the mark is redrawn on the pixel grid (see Small sizes), because a scaled cut blurs shut.</p>
</div>
</div>
</section>

<section>
<h2>Lockups</h2>
<div class="grid2">${lockups}</div>
<p class="note">Ink artwork on Paper, Paper artwork on Ink. Files: <code>brand/svg/</code> and <code>brand/png/</code> (512, 1024 and 2048 px, transparent and on background).</p>
</section>

<section>
<h2>Clear space and minimum size</h2>
<div class="grid2">
<figure>${clear}<figcaption>Keep half the mark's width clear on every side.</figcaption></figure>
<div style="display:grid;gap:12px;align-content:start">
<p>Smallest sizes:</p>
<div class="pane light" style="justify-content:flex-start;min-height:0;gap:22px">${svgFile(H, INK, { height: 20 })}${pixel16(INK)}</div>
<p class="note">Horizontal lockup: at least 20 px tall (about 80 px wide). Mark alone: 16 px, using the hand-drawn version.</p>
</div>
</div>
</section>

<section>
<h2>Small sizes</h2>
<p>At 16, 32 and 48 px the mark is drawn on the pixel grid: the cut is snapped to whole pixels row by row, so it stays open and sharp. Next to each, the vector scaled down, for comparison.</p>
<div class="grid3">${smalls}</div>
<p class="note">Files: <code>brand/favicon/</code> (favicon-16/32/48.png, favicon.ico, favicon.svg, apple-touch-icon.png, icon-512.png). The SVG favicon switches to Paper when the browser is dark.</p>
</section>

<section>
<h2>Motion</h2>
<p>"Join": your code slides in from the left, the API drops in from above and locks with a small settle, the word fades in, and the bar draws under api. About 1.6 seconds, once, and it ends on the static logo. Plain CSS, no script: <code>brand/motion/shapi-motion.css</code> with the markup in <code>brand/svg/web/shapi-lockup-animatable.svg</code>.</p>
<div class="grid3 motion">
<div><div class="pane light">${animatableSvg("currentColor", "sp-hover")}</div><figcaption>Hover (headers): the API piece lifts out and drops back in. Hover it.</figcaption></div>
<div><div class="pane dark status">${animatableSvg("currentColor", "sp-working")}<span>Scanning…</span></div><figcaption>Working: a loop for scans and fixes in progress.</figcaption></div>
<div><div class="pane light">${svgFile(H, INK, { height: 40 })}</div><figcaption>Reduced motion, favicon, avatar and social images: always the static logo.</figcaption></div>
</div>
</section>

<section>
<h2>In use</h2>
<div class="grid2">
<div class="mock">
<div class="tabs light"><div class="tab on">${pixel16(INK)}Accounts · SHAPI</div><div class="tab">${pixel16(INK)}Quickstart · SHAPI</div></div>
<div class="addr">app.shapi.dev</div>
</div>
<div class="mock">
<div class="tabs dark"><div class="tab on">${pixel16(PAPER)}Accounts · SHAPI</div><div class="tab">${pixel16(PAPER)}Quickstart · SHAPI</div></div>
<div class="addr">app.shapi.dev</div>
</div>
</div>
<div class="xprofile"><div class="av">${iconSvg(400, "dark")}</div><div><b>SHAPI</b><span>@handle · Your code, when the API changes</span></div><div class="av2" style="margin-left:auto">${iconSvg(400, "dark")}</div></div>
<div class="grid2">
<div class="slide">${svgFile(H, INK)}<div><div class="t">Third-party APIs change under you.</div><div class="s">SHAPI finds the lines that break, and fixes them test-first.</div></div></div>
<div class="cards" style="grid-template-columns:1fr">
<div class="card front">${svgFile(LAYOUT.mark, PAPER)}</div>
</div>
</div>
<div class="cards">
<div class="card back">${svgFile(H, INK)}<div class="who"><b>Name Surname</b><span>Founder · srivarshini09.github.io/YC</span></div></div>
<div class="card front">${svgFile(LAYOUT.stacked, PAPER).replace("<svg ", '<svg style="width:46%" ')}</div>
</div>
<div class="site">
<header><a href="#" aria-label="SHAPI home">${animatableSvg("currentColor", "sp-hover")}</a><nav><span>Quickstart</span><span>How it works</span><span>Advisories</span><span class="cta">Install the GitHub App</span></nav></header>
<div class="body"><div class="t">Your code, when the API changes</div><p>Stripe renames a value, Meta retires a version, GitHub answers 200 instead of 204.</p></div>
</div>
</section>

<section>
<h2>Social images</h2>
<div class="social">
<figure>${ogSvg("dark")}<figcaption>Link preview, og.png · 1200 × 630</figcaption></figure>
<figure>${ogSvg("light")}<figcaption>Link preview, light · 1200 × 630</figcaption></figure>
<figure>${bannerSvg(1500, 500, "dark", 560)}<figcaption>X header · 1500 × 500</figcaption></figure>
<figure>${bannerSvg(1584, 396, "light", 500, 0.62)}<figcaption>LinkedIn banner · 1584 × 396</figcaption></figure>
<figure class="sq">${iconSvg(400, "dark")}<figcaption>Avatar · 400 × 400 (and the 512 px GitHub App avatar)</figcaption></figure>
<figure class="sq">${iconSvg(400, "light")}<figcaption>Avatar, light</figcaption></figure>
</div>
</section>

<section>
<h2>Don'ts</h2>
<div class="grid3">${donts.map(([t, inner]) => `<figure class="dont">${lock(inner, dontView)}<figcaption>${t}</figcaption></figure>`).join("")}</div>
<p class="note">Do: Ink on Paper or Paper on Ink, half a mark of clear space, the hand-drawn mark below 48 px, and the static logo wherever motion would distract.</p>
</section>

<section>
<h2>Files</h2>
<table>
<tr><th>Folder</th><th>What</th></tr>
<tr><td><code>svg/</code></td><td>Mark, wordmark, horizontal and stacked lockups, light (Ink) and dark (Paper). <code>svg/web/</code> has currentColor versions and the animatable lockup.</td></tr>
<tr><td><code>png/</code></td><td>Every SVG at 512, 1024 and 2048 px wide, transparent and on background.</td></tr>
<tr><td><code>favicon/</code></td><td>Hand-drawn 16, 32 and 48 px, favicon.ico, favicon.svg, apple-touch-icon (180), icon-512 (GitHub App avatar).</td></tr>
<tr><td><code>social/</code></td><td>Avatar 400, X header 1500 × 500, LinkedIn banner 1584 × 396, og.png 1200 × 630; dark and light.</td></tr>
<tr><td><code>motion/</code></td><td>The motion CSS and self-contained animated SVGs for the README and npm.</td></tr>
<tr><td><code>fonts/</code></td><td>Inter's licence (SIL OFL 1.1).</td></tr>
</table>
<p class="note">Everything here comes from <code>brand/build_logo.mjs</code>. Change a number there and run <code>npm run build</code> in <code>brand/</code>; never edit an exported file.</p>
</section>

<section>
<h2>Sign-off</h2>
<ul class="check">
<li>The mark reads at 16 px, light and dark (Small sizes).</li>
<li>Every file comes from the build script, none edited by hand.</li>
<li>Font licence included.</li>
<li>Brand sheet sent to the founder.</li>
<li>Founder signs off on this page.</li>
</ul>
</section>

</main>
<script>
document.getElementById("replay").addEventListener("click", () => {
  for (const s of document.querySelectorAll("#hero .sp-logo")) s.replaceWith(s.cloneNode(true));
});
</script>
</body></html>`;
}
