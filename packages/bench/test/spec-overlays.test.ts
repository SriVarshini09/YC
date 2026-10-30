import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SPEC_SOURCES, advisoryToArazzo, advisoryToOverlays, applyOverlay, loadAdvisories, type SpecExcerpt } from "@shapi/core";

// Execution plan S-05: advisories as OpenAPI Overlays (the after-spec) and Arazzo workflows (the proving flow), for
// providers that publish their spec. Generated from the spec excerpts bench:spec-excerpts writes at each pinned commit.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const advisories = loadAdvisories(path.join(repoRoot, "advisories"));
const excerpts = Object.keys(SPEC_SOURCES).map((p) => JSON.parse(readFileSync(path.join(here, "..", "datasets", "spec-excerpts", `${p}.json`), "utf8")) as SpecExcerpt);
const schema = (name: string) => JSON.parse(readFileSync(path.join(repoRoot, "packages", "core", "test", "fixtures", name, "schema.json"), "utf8"));

/** Every published file: name → content, for each advisory that touches an operation in its provider's spec. */
function published(): Map<string, unknown> {
  const files = new Map<string, unknown>();
  for (const excerpt of excerpts) {
    for (const a of advisories.filter((x) => x.provider === excerpt.provider)) {
      const overlays = advisoryToOverlays(a, excerpt);
      overlays.forEach(({ overlay }, i) => files.set(`overlays/${a.id}${overlays.length > 1 ? `.${i + 1}` : ""}.overlay.json`, overlay));
      const arazzo = advisoryToArazzo(a, excerpt);
      if (arazzo) files.set(`arazzo/${a.id}.arazzo.json`, arazzo);
    }
  }
  return files;
}

describe("advisory overlays and Arazzo workflows (S-05)", () => {
  const files = published();

  it("covers every advisory whose operations are in its provider's pinned spec", () => {
    expect([...files.keys()].filter((f) => f.startsWith("overlays/"))).toHaveLength(18);
    expect([...files.keys()].filter((f) => f.startsWith("arazzo/"))).toHaveLength(18);
  });

  it("validates against the official Overlay 1.0 and Arazzo 1.0 schemas", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const overlay = ajv.compile(schema("overlay"));
    const arazzo = ajv.compile(schema("arazzo"));
    for (const [name, doc] of files) {
      const validate = name.startsWith("overlays/") ? overlay : arazzo;
      expect(validate(doc), `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
  });

  it("applies cleanly to the spec at the commit it extends: every action's target is there", () => {
    for (const excerpt of excerpts) {
      for (const a of advisories.filter((x) => x.provider === excerpt.provider)) {
        for (const { file, overlay } of advisoryToOverlays(a, excerpt)) {
          expect(overlay.extends).toContain(excerpt.commit);
          const spec = { paths: excerpt.files.find((f) => f.file === file)!.paths };
          expect(applyOverlay(spec, overlay).unmatched, `${a.id}`).toEqual([]);
        }
      }
    }
  });

  it("removes a shut-down operation, and swaps a retired 2xx response for the new one", () => {
    const github = excerpts.find((e) => e.provider === "github")!;
    const dispatch = advisories.find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
    const { overlay } = advisoryToOverlays(dispatch, github)[0]!;
    const op = github.files[0]!.paths["/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"]!.post!;
    const after = applyOverlay({ paths: github.files[0]!.paths }, overlay).result.paths["/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"]!.post as unknown as Record<string, unknown>;
    expect(after["x-shapi-advisory"]).toBe(dispatch.id);
    expect(Object.keys(after.responses as object)).toContain("200");
    if (!("200" in op.responses)) expect(overlay.actions.some((x) => x.target.endsWith(".responses"))).toBe(true);

    const openai = excerpts.find((e) => e.provider === "openai")!;
    const translations = advisories.find((a) => a.id === "openai-audio-translations-endpoint-shutdown")!;
    const removed = applyOverlay({ paths: openai.files[0]!.paths }, advisoryToOverlays(translations, openai)[0]!.overlay).result.paths["/audio/translations"];
    expect(removed?.post).toBeUndefined();
  });

  it("publishes them at shapi.dev/overlays and shapi.dev/arazzo, in sync (UPDATE_SPECS=1 rewrites them)", () => {
    const root = path.join(repoRoot, "site", "public");
    const text = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_SPECS || !existsSync(path.join(root, "overlays"))) {
      for (const d of ["overlays", "arazzo"]) {
        rmSync(path.join(root, d), { recursive: true, force: true });
        mkdirSync(path.join(root, d), { recursive: true });
      }
      for (const [name, doc] of files) writeFileSync(path.join(root, name), text(doc));
    }
    const onDisk = ["overlays", "arazzo"].flatMap((d) => readdirSync(path.join(root, d)).map((f) => `${d}/${f}`)).sort();
    expect(onDisk).toEqual([...files.keys()].sort());
    for (const [name, doc] of files) expect(readFileSync(path.join(root, name), "utf8"), name).toBe(text(doc));
  });
});
