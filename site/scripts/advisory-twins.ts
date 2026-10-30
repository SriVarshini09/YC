// Markdown twins of the advisory pages (execution plan G-04): /advisories/<id>.md beside each page, written into the
// built site after `vitepress build`, which would otherwise compile any .md under site/ (public/ included) as a page.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advisoryMarkdown, loadAdvisories } from "@shapi/core";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(site, ".vitepress", "dist", "advisories");
mkdirSync(out, { recursive: true });
const advisories = loadAdvisories(path.join(site, "..", "advisories"));
for (const a of advisories) writeFileSync(path.join(out, `${a.id}.md`), advisoryMarkdown(a));
console.log(`wrote ${advisories.length} advisory twins to ${path.relative(site, out)}`);
