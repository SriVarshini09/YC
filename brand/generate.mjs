// Generates every SHAPI logo asset from the "Shape + Pulse" design: a navy tile, a white hexagon,
// and a pulse line that glitches and ends in a check (electric blue to mint).
//
//   cd brand && npm install && npm run generate
//
// Writes brand/* (sources and PNG exports), site/public/* (favicons, logos and the social image
// for the docs site) and apps/server/src/web/brand.ts (the same assets, inlined for the web app,
// which serves no files from disk). The wordmark is set in Space Grotesk SemiBold and converted
// to outlines, so nothing depends on an installed font.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";
import pngToIco from "png-to-ico";

const require = createRequire(import.meta.url);
const brandDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(brandDir, "..");
const siteDir = path.join(root, "site", "public");
const serverBrand = path.join(root, "apps", "server", "src", "web", "brand.ts");
mkdirSync(siteDir, { recursive: true });

export const NAVY = "#0B1F4D";
export const BLUE = "#2F6BFF";
export const MINT = "#19D3A2";

const fontPath = (weight) => require.resolve(`@fontsource/space-grotesk/files/space-grotesk-latin-${weight}-normal.woff`);
const loadFont = (weight) => {
  const bytes = readFileSync(fontPath(weight));
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const semiBold = loadFont(600);
const medium = loadFont(500);

/** Text as an outlined SVG path: { d, width, xHeight } in user units. */
function textPath(font, text, size, x, y, tracking = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  let cx = x;
  let d = "";
  glyphs.forEach((g, i) => {
    d += g.getPath(cx, y, size).toPathData(2) + " ";
    cx += g.advanceWidth * scale + tracking * size;
    if (i < glyphs.length - 1) cx += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { d: d.trim(), width: cx - x - tracking * size, xHeight: (font.tables.os2?.sxHeight ?? font.unitsPerEm * 0.5) * scale };
}

// ---------- The mark, in a 64x64 space ----------
const gradient = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BLUE}"/><stop offset="0.5" stop-color="${BLUE}"/><stop offset="0.82" stop-color="${MINT}"/><stop offset="1" stop-color="${MINT}"/></linearGradient>`;
const HEX = "M49.3 22 V42 L32 52 L14.7 42 V22 L32 12 Z";
// A flat line, a glitching spike, back to the baseline, then a check that finishes in mint.
const PULSE = "M19 33 H24.3 L27.4 24.2 L31.4 42 L34.8 33 H37.4 L40.6 36.6 L45.6 27.4";
// The favicon's pulse: no hexagon and a thicker stroke, so it survives 16px.
const PULSE_SMALL = "M11 34 H19.2 L24.3 19 L30.6 47 L35.8 34 H39.6 L44 39 L53 26.5";

const tile = `<rect width="64" height="64" rx="15" fill="${NAVY}"/>`;
const hexagon = `<path d="${HEX}" fill="none" stroke="#FFFFFF" stroke-opacity="0.92" stroke-width="3.5" stroke-linejoin="round"/>`;
const pulse = (gid) => `<path d="${PULSE}" fill="none" stroke="url(#${gid})" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const svg = (w, h, body, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${extra}>${body}</svg>`;

const iconSvg = svg(64, 64, `<defs>${gradient("sp-g")}</defs>${tile}${hexagon}${pulse("sp-g")}`, ' role="img" aria-label="SHAPI"');
const markSvg = svg(64, 64, `<defs>${gradient("sp-m")}</defs>${hexagon}${pulse("sp-m")}`);
const faviconSvg = svg(
  64,
  64,
  `<defs>${gradient("sp-f")}</defs>${tile}<path d="${PULSE_SMALL}" fill="none" stroke="url(#sp-f)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`,
);

/** The horizontal lockup: icon + "shapi". The lowercase x-height sits on the hexagon's middle band. */
function lockup(textFill, id) {
  const size = 44;
  const gap = 16;
  const probe = textPath(semiBold, "shapi", size, 0, 0, -0.012);
  const baseline = 32 + probe.xHeight / 2 + 0.5;
  const t = textPath(semiBold, "shapi", size, 64 + gap, baseline, -0.012);
  const w = Math.ceil(64 + gap + t.width + 2);
  return { width: w, svg: svg(w, 64, `<defs>${gradient(id)}</defs>${tile}${hexagon}${pulse(id)}<path d="${t.d}" fill="${textFill}"/>`, ' role="img" aria-label="shapi"') };
}
const logoLight = lockup(NAVY, "sp-ll");
const logoDark = lockup("#FFFFFF", "sp-ld");
const logoInline = lockup("currentColor", "sp-lc");

/** Social share image, 1200x630. */
function social() {
  const W = 1200;
  const H = 630;
  const markScale = 3.6;
  const markSize = 64 * markScale;
  const mx = 110;
  const my = (H - markSize) / 2 - 30;
  const word = textPath(semiBold, "shapi", 150, 0, 0, -0.015);
  const wx = mx + markSize + 56;
  const wy = my + markSize / 2 + word.xHeight / 2 + 2;
  const tag1 = textPath(medium, "Find the code that breaks when a third-party API changes,", 34, mx, H - 158);
  const tag2 = textPath(medium, "and fix it test-first.", 34, mx, H - 112);
  const hexes = [0, 1, 2, 3].map((i) => `<path transform="translate(${900 + i * 30},${-120 + i * 170}) scale(4.2)" d="${HEX}"/>`).join("");
  return svg(
    W,
    H,
    `<defs>${gradient("sp-s")}<radialGradient id="sp-bg" cx="0.82" cy="0.1" r="0.9"><stop offset="0" stop-color="#1A3C8F"/><stop offset="0.55" stop-color="${NAVY}"/><stop offset="1" stop-color="#071538"/></radialGradient><linearGradient id="sp-line" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${MINT}"/></linearGradient></defs>` +
      `<rect width="${W}" height="${H}" fill="url(#sp-bg)"/>` +
      `<g opacity="0.07" stroke="#FFFFFF" stroke-width="2" fill="none">${hexes}</g>` +
      `<g transform="translate(${mx},${my}) scale(${markScale})">${hexagon}${pulse("sp-s")}</g>` +
      `<path d="${word.d}" transform="translate(${wx},${wy})" fill="#FFFFFF"/>` +
      `<rect x="${mx}" y="${H - 200}" width="88" height="5" rx="2.5" fill="url(#sp-line)"/>` +
      `<path d="${tag1.d}" fill="#FFFFFF" fill-opacity="0.82"/><path d="${tag2.d}" fill="#FFFFFF" fill-opacity="0.82"/>`,
  );
}
const socialSvg = social();

// ---------- Exports ----------
const png = (source, width) => new Resvg(source, { fitTo: { mode: "width", value: width } }).render().asPng();
const ico = (...sizes) => pngToIco(sizes.map((s) => png(faviconSvg, s)));
const write = (dir, name, data) => writeFileSync(path.join(dir, name), data);

const faviconIco = await ico(16, 32, 48);
const appleTouch = png(iconSvg, 180);

for (const [name, data] of Object.entries({
  "shapi-icon.svg": iconSvg,
  "shapi-mark.svg": markSvg,
  "favicon.svg": faviconSvg,
  "favicon.ico": faviconIco,
  "shapi-logo-light.svg": logoLight.svg,
  "shapi-logo-dark.svg": logoDark.svg,
  "shapi-social.svg": socialSvg,
  "shapi-icon-512.png": png(iconSvg, 512),
  "shapi-icon-256.png": png(iconSvg, 256),
  "apple-touch-icon.png": appleTouch,
  "shapi-logo-light.png": png(logoLight.svg, logoLight.width * 4),
  "shapi-logo-dark.png": png(logoDark.svg, logoDark.width * 4),
  "shapi-social.png": png(socialSvg, 1200),
})) {
  write(brandDir, name, data);
}

for (const [name, data] of Object.entries({
  "favicon.svg": faviconSvg,
  "favicon.ico": faviconIco,
  "apple-touch-icon.png": appleTouch,
  "shapi-icon.svg": iconSvg,
  "shapi-logo-light.svg": logoLight.svg,
  "shapi-logo-dark.svg": logoDark.svg,
  "og.png": png(socialSvg, 1200),
})) {
  write(siteDir, name, data);
}

// The web app serves no files from disk, so it gets the assets as strings. Inline SVG carries no
// style attributes, which keeps it within the page's content security policy.
const inlineLogo = logoInline.svg.replace(/ width="\d+" height="\d+"/, "");
writeFileSync(
  serverBrand,
  `// Generated by brand/generate.mjs. Do not edit; change the design there and regenerate.

/** The horizontal lockup (icon + "shapi"); the wordmark follows the surrounding text colour. */
export const LOGO_SVG = ${JSON.stringify(inlineLogo)};

/** Pulse-only favicon, drawn for 16 to 32 pixels. */
export const FAVICON_SVG = ${JSON.stringify(faviconSvg)};

/** The same favicon as an ICO (16, 32 and 48 pixels), for browsers without SVG favicon support. */
export const FAVICON_ICO = Buffer.from(${JSON.stringify((await ico(16, 32, 48)).toString("base64"))}, "base64");

/** The icon at 180 pixels, for iOS home screens and Safari's pinned tabs. */
export const APPLE_TOUCH_ICON = Buffer.from(${JSON.stringify(appleTouch.toString("base64"))}, "base64");
`,
);

console.log(`wrote brand assets to ${brandDir}, ${siteDir} and ${serverBrand}`);
