# SHAPI brand

The logo is a square cut in two by one curve: your code on the left, the API on the right, two pieces that still fit. Beside it, "shapi" in Inter SemiBold with a bar under "api": the API side, held. Two colours, Ink `#0E0F12` and Paper `#F7F6F2`, and nothing else.

Open `brand-sheet.html` for every asset, the construction, clear space, minimum sizes, small sizes, motion, mockups and the don'ts.

| Folder | What |
| --- | --- |
| `svg/` | Mark, wordmark, horizontal and stacked lockups, light (Ink) and dark (Paper). `svg/web/` has currentColor versions and the animatable lockup. |
| `png/` | Every SVG at 512, 1024 and 2048 px wide, transparent and on background. |
| `favicon/` | Hand-drawn 16, 32 and 48 px, `favicon.ico`, `favicon.svg`, `apple-touch-icon.png` (180), `icon-512.png` (the GitHub App avatar; upload it in the app's settings on GitHub). |
| `social/` | Avatar 400, X header 1500 × 500, LinkedIn banner 1584 × 396, `og.png` 1200 × 630; dark and light. |
| `motion/` | `shapi-motion.css` (intro, hover, working; no script) and self-contained animated SVGs for the README and npm. |
| `fonts/` | Inter's licence (SIL Open Font License 1.1). The wordmark is Inter, converted to outlines. |

## Changing anything

Every file is generated from the numbers at the top of `build_logo.mjs`. Never edit an exported file; change a number and rebuild:

```sh
cd brand && npm install && npm run build
```

This folder is outside the pnpm workspace, so its rendering dependencies are not installed with the rest of the repository.
