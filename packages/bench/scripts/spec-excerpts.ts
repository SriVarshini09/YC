/**
 * Spec excerpts for the advisory overlays (execution plan S-05): each pinned provider spec (packages/core/spec-sources.json)
 * is fetched at its commit, the operations the provider's advisories touch are written to
 * datasets/spec-excerpts/<provider>.json, and every advisory's overlay is applied to the full spec. It exits 1 if
 * any overlay action's target is missing from the spec at that commit.
 *
 *   pnpm --filter @shapi/bench bench:spec-excerpts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_SOURCES, advisoryToOverlays, applyOverlay, loadAdvisories, operationsFor, specFileUrl, type SpecExcerpt } from "@shapi/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");
const advisories = loadAdvisories(path.resolve(benchRoot, "..", "..", "advisories"));
const out = path.join(benchRoot, "datasets", "spec-excerpts");
mkdirSync(out, { recursive: true });

let unmatched = 0;
for (const [provider, source] of Object.entries(SPEC_SOURCES)) {
  const mine = advisories.filter((a) => a.provider === provider);
  const excerpt: SpecExcerpt = { provider, repo: source.repo, commit: source.commit, files: [] };
  const full = new Map<string, { paths: Record<string, Record<string, unknown>> }>();
  for (const file of source.files) {
    const url = specFileUrl(source, file);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
    const spec = (await res.json()) as { servers?: { url: string }[]; paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> };
    full.set(file, spec);
    const base = spec.servers?.[0] ? new URL(spec.servers[0].url).pathname.replace(/\/+$/, "") : "";
    const paths: SpecExcerpt["files"][number]["paths"] = {};
    for (const a of mine) {
      for (const [p, m] of operationsFor(a, { base, paths: spec.paths })) {
        const op = spec.paths[p]![m]!;
        paths[p] ??= {};
        paths[p][m] = { ...(op.operationId ? { operationId: op.operationId } : {}), responses: Object.fromEntries(Object.keys(op.responses ?? {}).sort().map((c) => [c, {}])) };
      }
    }
    if (Object.keys(paths).length) excerpt.files.push({ file, base, paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) });
  }
  writeFileSync(path.join(out, `${provider}.json`), `${JSON.stringify(excerpt, null, 2)}\n`);
  for (const a of mine) {
    for (const { file, overlay } of advisoryToOverlays(a, excerpt)) {
      const applied = applyOverlay(full.get(file), overlay);
      unmatched += applied.unmatched.length;
      console.log(`${a.id} → ${file}: ${overlay.actions.length} actions${applied.unmatched.length ? `, UNMATCHED ${applied.unmatched.join(", ")}` : ", applies cleanly"}`);
    }
  }
  console.log(`${provider}: ${excerpt.files.reduce((n, f) => n + Object.keys(f.paths).length, 0)} paths at ${source.commit.slice(0, 12)}`);
}
process.exit(unmatched ? 1 : 0);
