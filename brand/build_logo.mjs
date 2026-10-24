// Builds every SHAPI logo file from the numbers below:
//   cd brand && npm install && npm run build
// Nothing in svg/, png/, favicon/, social/, motion/ or brand-sheet.html is edited by hand.
//
// The logo: a square cut in two by an S-curve (your code on the left, the API on the right, two pieces
// that still fit), beside "shapi" in Inter SemiBold with a bar under "api" (the API side, held).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";
import pngToIco from "png-to-ico";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIRS = ["svg", "png", "favicon", "social", "motion", "fonts"];

// ======================================================================================
// 1. The numbers
// ======================================================================================
const INK = "#0E0F12"; // the one dark colour
const PAPER = "#F7F6F2"; // the one light colour

// The mark, on a 76-unit square.
const CUT = 76;
const GAP = 8; // width of the cut
const LEFT = "M0 0 H48 C48 40 28 36 28 76 H0 Z"; // your code
const RIGHT = "M56 0 H76 V76 H36 C36 36 56 40 56 0 Z"; // the API
const SEAM = [[52, 0], [52, 38], [32, 38], [32, 76]]; // the centre line of the cut (cubic Bézier)

// The wordmark, in units where the font size is 66.
const SIZE = 66;
const TRACK = -0.015; // em
const BAR_DY = 12; // bar top below the baseline
const BAR_H = 6;
const MARK_GAP = 16; // mark to wordmark, horizontal lockup
const STACK_SCALE = 1.3; // stacked: mark side as a multiple of the ascender
const STACK_GAP = 22; // stacked: mark bottom to wordmark top
const CLEAR = 0.5; // clear space around any lockup, as a fraction of the mark's side

// Hand-drawn small sizes: the square inset by `margin`, the cut snapped to whole pixels, `gap` wide.
const PIXEL = [
  { n: 16, margin: 1, gap: 2 },
  { n: 32, margin: 2, gap: 3 },
  { n: 48, margin: 3, gap: 4 },
];

const PNG_SIZES = [512, 1024, 2048];
const TAGLINE = ["Find the code that breaks when a third-party API changes,", "and fix it test-first."];

// ======================================================================================
// 2. Type
// ======================================================================================
const loadFont = (weight) => {
  const b = readFileSync(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const SEMI = loadFont(600);
const MEDIUM = loadFont(500);

/** Set `str` as outlines with the font's own kerning. Returns the path, glyph origins and ink box. */
function setText(font, str, size, x, y, tracking = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(str);
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const pos = [];
  let cx = x;
  let d = "";
  glyphs.forEach((g, i) => {
    const p = g.getPath(cx, y, size);
    d += p.toPathData(2) + " ";
    const b = p.getBoundingBox();
    if (Number.isFinite(b.x1)) {
      box.x1 = Math.min(box.x1, b.x1);
      box.y1 = Math.min(box.y1, b.y1);
      box.x2 = Math.max(box.x2, b.x2);
      box.y2 = Math.max(box.y2, b.y2);
    }
    pos.push({ x: cx, w: g.advanceWidth * scale });
    cx += g.advanceWidth * scale + tracking * size;
    if (i < glyphs.length - 1) cx += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { d: d.trim(), glyphs: pos, box, width: cx - x - tracking * size };
}

const ASC = -SEMI.charToGlyph("h").getPath(0, 0, SIZE).getBoundingBox().y1; // top of the h above the baseline

// ======================================================================================
// 3. Geometry of each lockup (unit coordinates, no colour)
// ======================================================================================
const f2 = (n) => Number(n.toFixed(2));

function wordAt(x, base) {
  const w = setText(SEMI, "shapi", SIZE, x, base, TRACK);
  const g = w.glyphs;
  const bar = { x: g[2].x, y: base + BAR_DY, w: g[4].x + g[4].w - g[2].x, h: BAR_H };
  return { ...w, bar };
}

/** Each layout: optional mark {x, y, side}, optional word, and its tight box {x, y, w, h}. */
const LAYOUT = {
  mark: { mark: { x: 0, y: 0, side: CUT }, box: { x: 0, y: 0, w: CUT, h: CUT } },
  wordmark: (() => {
    const word = wordAt(0, ASC);
    const right = Math.max(word.box.x2, word.bar.x + word.bar.w);
    return { word, box: { x: word.box.x1, y: word.box.y1, w: right - word.box.x1, h: word.bar.y + word.bar.h - word.box.y1 } };
  })(),
  horizontal: (() => {
    const word = wordAt(ASC + MARK_GAP, ASC);
    const top = Math.min(0, word.box.y1);
    const right = Math.max(word.box.x2, word.bar.x + word.bar.w);
    return { mark: { x: 0, y: 0, side: ASC }, word, box: { x: 0, y: top, w: right, h: word.bar.y + word.bar.h - top } };
  })(),
  stacked: (() => {
    const side = ASC * STACK_SCALE;
    const probe = wordAt(0, 0);
    const base = side + STACK_GAP - probe.box.y1;
    const word = wordAt(0, base);
    const left = word.box.x1;
    const right = Math.max(word.box.x2, word.bar.x + word.bar.w);
    const mx = (left + right) / 2 - side / 2;
    return { mark: { x: mx, y: 0, side }, word, box: { x: left, y: 0, w: right - left, h: word.bar.y + word.bar.h } };
  })(),
};

// ======================================================================================
// 4. Drawing
// ======================================================================================
const markPaths = (fill) => `<path d="${LEFT}" fill="${fill}"/><path d="${RIGHT}" fill="${fill}"/>`;
const placeMark = (m, inner) => `<g transform="translate(${f2(m.x)} ${f2(m.y)}) scale(${f2(m.side / CUT)})">${inner}</g>`;
const rect = (r, fill) => `<rect x="${f2(r.x)}" y="${f2(r.y)}" width="${f2(r.w)}" height="${f2(r.h)}" fill="${fill}"/>`;

/** The artwork of a layout in unit coordinates. */
function art(layout, fill) {
  let s = "";
  if (layout.mark) s += placeMark(layout.mark, markPaths(fill));
  if (layout.word) s += `<path d="${layout.word.d}" fill="${fill}"/>` + rect(layout.word.bar, fill);
  return s;
}

/** A standalone SVG of a layout, `height` px tall, with optional background and clear space. */
function svgFile(layout, fill, { height = 64, background, pad = 0, label = "shapi" } = {}) {
  const b = layout.box;
  const vb = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
  const width = (height * vb.w) / vb.h;
  const bg = background ? `<rect x="${f2(vb.x)}" y="${f2(vb.y)}" width="${f2(vb.w)}" height="${f2(vb.h)}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f2(width)}" height="${height}" viewBox="${f2(vb.x)} ${f2(vb.y)} ${f2(vb.w)} ${f2(vb.h)}" role="img" aria-label="${label}">${bg}${art(layout, fill)}</svg>`;
}

/** Place a layout's artwork inside another drawing: centred at (cx, cy), `w` units wide. */
function placed(layout, fill, cx, cy, w) {
  const b = layout.box;
  const k = w / b.w;
  return `<g transform="translate(${f2(cx - w / 2)} ${f2(cy - (b.h * k) / 2)}) scale(${f2(k)}) translate(${f2(-b.x)} ${f2(-b.y)})">${art(layout, fill)}</g>`;
}

// ---- Hand-drawn small sizes ----
const bez = (t, a) => (1 - t) ** 3 * a[0] + 3 * (1 - t) ** 2 * t * a[1] + 3 * (1 - t) * t ** 2 * a[2] + t ** 3 * a[3];
const SEAM_SAMPLES = Array.from({ length: 2001 }, (_, i) => {
  const t = i / 2000;
  return { y: bez(t, SEAM.map((p) => p[1])), x: bez(t, SEAM.map((p) => p[0])) };
});
const seamX = (y) => SEAM_SAMPLES.reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best)).x;

/** The mark drawn on an n x n pixel grid: each row's cut snapped to whole pixels, rows merged into rects. */
function pixelRects({ n, margin, gap }) {
  const s = n - 2 * margin;
  const starts = Array.from({ length: s }, (_, r) => Math.round(margin + (seamX(((r + 0.5) / s) * CUT) / CUT) * s - gap / 2));
  let rects = "";
  let from = 0;
  for (let r = 1; r <= s; r++) {
    if (r < s && starts[r] === starts[from]) continue;
    const y = margin + from;
    const h = r - from;
    const g0 = starts[from];
    rects += `<rect x="${margin}" y="${y}" width="${g0 - margin}" height="${h}"/><rect x="${g0 + gap}" y="${y}" width="${n - margin - g0 - gap}" height="${h}"/>`;
    from = r;
  }
  return rects;
}
const pixelSvg = (spec, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.n}" height="${spec.n}" viewBox="0 0 ${spec.n} ${spec.n}" shape-rendering="crispEdges"><g fill="${fill}">${pixelRects(spec)}</g></svg>`;

// ---- Social and app icons ----
function iconSvg(size, theme, frac = 0.5) {
  const [bg, fg] = theme === "dark" ? [INK, PAPER] : [PAPER, INK];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${placed(LAYOUT.mark, fg, size / 2, size / 2, size * frac)}</svg>`;
}

function bannerSvg(w, h, theme, lockW, cx = 0.5) {
  const [bg, fg] = theme === "dark" ? [INK, PAPER] : [PAPER, INK];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${placed(LAYOUT.horizontal, fg, w * cx, h / 2, lockW)}</svg>`;
}

function ogSvg(theme) {
  const W = 1200;
  const H = 630;
  const [bg, fg] = theme === "dark" ? [INK, PAPER] : [PAPER, INK];
  const lockW = 560;
  const lockH = (LAYOUT.horizontal.box.h * lockW) / LAYOUT.horizontal.box.w;
  const cy = 250;
  const lines = TAGLINE.map((line, i) => {
    const t = setText(MEDIUM, line, 34, 0, 0);
    return `<path d="${setText(MEDIUM, line, 34, (W - t.width) / 2, cy + lockH / 2 + 96 + i * 48).d}" fill="${fg}" fill-opacity="0.72"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${bg}"/>${placed(LAYOUT.horizontal, fg, W / 2, cy, lockW)}${lines}</svg>`;
}

// ======================================================================================
// 5. Motion ("Join"): your code slides in, the API drops in, they lock, then "api" is held.
// ======================================================================================
const MOTION_CSS = `/* SHAPI logo motion. Generated by brand/build_logo.mjs. Plain CSS, no script.
   Markup: svg/web/shapi-lockup-animatable.svg. Add one class to the <svg>:
   sp-join (intro, once), sp-hover (header hover), sp-working (in-progress loop). */
.sp-logo .sp-left, .sp-logo .sp-right, .sp-logo .sp-right-inner, .sp-logo .sp-word, .sp-logo .sp-bar { transform-box: fill-box; }
.sp-logo .sp-bar { transform-origin: left center; }

/* Intro, about 1.6s: your code slides in from the left, the API drops in from above and locks with a
   small settle, the word fades in, and the bar draws under "api". Ends on the static logo. */
.sp-join .sp-left { animation: sp-in-left .6s cubic-bezier(.2,.8,.2,1) both; }
.sp-join .sp-right { animation: sp-in-right .6s .18s cubic-bezier(.3,1.4,.5,1) both; }
.sp-join .sp-word { animation: sp-in-word .5s .55s cubic-bezier(.2,.8,.2,1) both; }
.sp-join .sp-bar { animation: sp-hold .45s 1.1s cubic-bezier(.2,.8,.2,1) both; }
@keyframes sp-in-left { from { opacity: 0; transform: translateX(-22px); } to { opacity: 1; transform: none; } }
@keyframes sp-in-right { from { opacity: 0; transform: translateY(-26px); } to { opacity: 1; transform: none; } }
@keyframes sp-in-word { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
@keyframes sp-hold { from { transform: scaleX(0); } to { transform: scaleX(1); } }

/* Hover: the API piece lifts out and drops back into place. */
.sp-hover:hover .sp-right-inner, a:hover .sp-hover .sp-right-inner, a:focus-visible .sp-hover .sp-right-inner { animation: sp-reseat .55s cubic-bezier(.3,1.4,.5,1); }
@keyframes sp-reseat { 0% { transform: none; } 40% { transform: translateY(-12px); } 100% { transform: none; } }

/* Working: the API piece keeps lifting out and being put back while SHAPI scans or fixes. */
.sp-working .sp-right-inner { animation: sp-reseat-loop 1.4s cubic-bezier(.45,0,.3,1) infinite; }
@keyframes sp-reseat-loop { 0%, 100% { transform: none; } 45%, 55% { transform: translateY(-14px); } }

/* No motion for visitors who ask for less: the static logo. */
@media (prefers-reduced-motion: reduce) { .sp-logo, .sp-logo * { animation: none !important; } }
`;

/** The horizontal lockup with its moving parts as separate elements. Wrappers carry no transform attribute. */
function animatableSvg(fill = "currentColor", cls = "") {
  const L = LAYOUT.horizontal;
  const b = L.box;
  const m = L.mark;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="sp-logo${cls ? " " + cls : ""}" viewBox="${f2(b.x)} ${f2(b.y)} ${f2(b.w)} ${f2(b.h)}" role="img" aria-label="shapi">` +
    `<g transform="translate(${f2(m.x)} ${f2(m.y)}) scale(${f2(m.side / CUT)})">` +
    `<g class="sp-left"><path d="${LEFT}" fill="${fill}"/></g>` +
    `<g class="sp-right"><g class="sp-right-inner"><path d="${RIGHT}" fill="${fill}"/></g></g></g>` +
    `<g class="sp-word"><path d="${L.word.d}" fill="${fill}"/></g>` +
    `<g class="sp-bar">${rect(L.word.bar, fill)}</g></svg>`;
}

/** Self-contained animated SVG (the intro plays once when the image loads): for the README and npm. */
const animatedFile = (fill, height = 64) =>
  animatableSvg(fill, "sp-join")
    .replace("<svg ", `<svg width="${f2((height * LAYOUT.horizontal.box.w) / LAYOUT.horizontal.box.h)}" height="${height}" `)
    .replace(/<\/svg>$/, `<style>${MOTION_CSS}</style></svg>`);

// ======================================================================================
// 6. Write everything
// ======================================================================================
const out = (...p) => path.join(ROOT, ...p);
for (const d of OUT_DIRS) rmSync(out(d), { recursive: true, force: true });
for (const d of [...OUT_DIRS, "svg/web"]) mkdirSync(out(d), { recursive: true });
const write = (rel, data) => writeFileSync(out(rel), data);
const png = (svg, width) => new Resvg(svg, { fitTo: { mode: "width", value: Math.round(width) } }).render().asPng();

// Font licence, next to the outlines made from the font.
copyFileSync(require.resolve("@fontsource/inter/LICENSE"), out("fonts", "Inter-OFL.txt"));

// svg/ and png/
const THEMES = { light: { fill: INK, bg: PAPER }, dark: { fill: PAPER, bg: INK } };
const ASSETS = { mark: LAYOUT.mark, wordmark: LAYOUT.wordmark, "lockup-horizontal": LAYOUT.horizontal, "lockup-stacked": LAYOUT.stacked };
const files = [];
for (const [name, layout] of Object.entries(ASSETS)) {
  const pad = CLEAR * (layout.mark ? layout.mark.side : ASC);
  for (const [theme, c] of Object.entries(THEMES)) {
    const plain = svgFile(layout, c.fill, { height: 64 });
    const onBg = svgFile(layout, c.fill, { height: 64, background: c.bg, pad });
    write(`svg/shapi-${name}-${theme}.svg`, plain);
    files.push(`svg/shapi-${name}-${theme}.svg`);
    for (const size of PNG_SIZES) {
      write(`png/shapi-${name}-${theme}-${size}.png`, png(plain, size));
      write(`png/shapi-${name}-${theme}-on-bg-${size}.png`, png(onBg, size));
    }
  }
}
write("svg/web/shapi-lockup-currentcolor.svg", svgFile(LAYOUT.horizontal, "currentColor"));
write("svg/web/shapi-mark-currentcolor.svg", svgFile(LAYOUT.mark, "currentColor"));
write("svg/web/shapi-lockup-animatable.svg", animatableSvg());

// favicon/
for (const spec of PIXEL) write(`favicon/favicon-${spec.n}.png`, png(pixelSvg(spec, INK), spec.n));
write("favicon/favicon.ico", await pngToIco(PIXEL.map((spec) => png(pixelSvg(spec, INK), spec.n))));
// SVG favicon: the 32px drawing, ink on light browser chrome and paper on dark.
write(
  "favicon/favicon.svg",
  pixelSvg(PIXEL[1], INK).replace(`<g fill="${INK}">`, "<g>").replace("shape-rendering=\"crispEdges\">", `shape-rendering="crispEdges"><style>g{fill:${INK}}@media (prefers-color-scheme:dark){g{fill:${PAPER}}}</style>`),
);
write("favicon/apple-touch-icon.png", png(iconSvg(180, "dark", 0.52), 180));
write("favicon/icon-512.png", png(iconSvg(512, "dark"), 512)); // GitHub App avatar
write("favicon/icon-512-light.png", png(iconSvg(512, "light"), 512));

// social/
for (const theme of ["dark", "light"]) {
  write(`social/avatar-${theme}.png`, png(iconSvg(400, theme), 400));
  write(`social/x-header-${theme}.png`, png(bannerSvg(1500, 500, theme, 560), 1500));
  write(`social/linkedin-banner-${theme}.png`, png(bannerSvg(1584, 396, theme, 500, 0.62), 1584));
  write(`social/og-${theme}.png`, png(ogSvg(theme), 1200));
}
write("social/og.png", png(ogSvg("dark"), 1200));

// motion/
write("motion/shapi-motion.css", MOTION_CSS);
write("motion/shapi-logo-animated-light.svg", animatedFile(INK));
write("motion/shapi-logo-animated-dark.svg", animatedFile(PAPER));

// ======================================================================================
// 7. Copies the web app and the docs site read (they serve no files from brand/)
// ======================================================================================
const REPO = path.resolve(ROOT, "..");
const toRepo = (rel, data) => writeFileSync(path.join(REPO, rel), data);
const faviconSvg = readFileSync(out("favicon/favicon.svg"), "utf8");
const faviconIco = readFileSync(out("favicon/favicon.ico"));
const appleTouch = readFileSync(out("favicon/apple-touch-icon.png"));
const banner = "// Generated by brand/build_logo.mjs. Do not edit; change the numbers there and run `npm run build` in brand/.\n";

// Web app: no files on disk, so the assets are strings. Inline SVG and a stylesheet: nothing the CSP blocks.
toRepo(
  "apps/server/src/web/brand.ts",
  `${banner}
/** Header logo: the horizontal lockup in the text colour; the API piece lifts and drops back on hover. */
export const LOGO_SVG = ${JSON.stringify(animatableSvg("currentColor", "sp-hover"))};

/** Sign-in page logo: plays the intro once (your code slides in, the API drops in, "api" is held). */
export const LOGO_INTRO_SVG = ${JSON.stringify(animatableSvg("currentColor", "sp-join"))};

/** The logo's motion: intro, hover, working loop, and none for reduced motion. Appended to the app's stylesheet. */
export const MOTION_CSS = ${JSON.stringify(MOTION_CSS)};

/** Hand-drawn 32px favicon; Ink on light browser chrome, Paper on dark. */
export const FAVICON_SVG = ${JSON.stringify(faviconSvg)};

/** Hand-drawn 16, 32 and 48px favicons as one ICO, for browsers without SVG favicons. */
export const FAVICON_ICO = Buffer.from(${JSON.stringify(faviconIco.toString("base64"))}, "base64");

/** 180px icon for iOS home screens. */
export const APPLE_TOUCH_ICON = Buffer.from(${JSON.stringify(appleTouch.toString("base64"))}, "base64");
`,
);

// Docs site: favicons and the link preview in site/public, the inline logos and motion in the theme.
mkdirSync(path.join(REPO, "site/public"), { recursive: true });
toRepo("site/public/favicon.svg", faviconSvg);
toRepo("site/public/favicon.ico", faviconIco);
toRepo("site/public/apple-touch-icon.png", appleTouch);
toRepo("site/public/og.png", readFileSync(out("social/og.png")));
toRepo(
  "site/.vitepress/theme/brand.ts",
  `${banner}
/** Nav logo: the horizontal lockup in the text colour, with the hover motion. */
export const LOGO_HOVER = ${JSON.stringify(animatableSvg("currentColor", "sp-hover"))};

/** Home hero logo: plays the intro once. */
export const LOGO_INTRO = ${JSON.stringify(animatableSvg("currentColor", "sp-join"))};
`,
);
toRepo("site/.vitepress/theme/shapi-motion.css", MOTION_CSS);

// The brand sheet, built from the same drawings.
const { brandSheet } = await import("./brand_sheet.mjs");
write("brand-sheet.html", brandSheet({ INK, PAPER, CUT, GAP, LEFT, RIGHT, SEAM, ASC, CLEAR, PIXEL, LAYOUT, art, svgFile, pixelSvg, iconSvg, bannerSvg, ogSvg, animatableSvg, placed, MOTION_CSS, markPaths, f2 }));

console.log(`built: ${files.length} SVG lockups, ${files.length * PNG_SIZES.length * 2} PNGs, favicons, social images, motion, brand-sheet.html`);
