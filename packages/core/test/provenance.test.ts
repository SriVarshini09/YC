import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories, pageText, provenanceProblems, type Advisory } from "../src/index";

// Execution plan C-02: every verified advisory carries the provider's exact words, and CI finds them in the snapshot.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories");
const snapshot = (sha: string) => {
  const file = path.join(dir, "evidence", "snapshots", `${sha}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};
const advisories = loadAdvisories(dir);

describe("advisory provenance (C-02)", () => {
  it("every verified advisory has a quote that its source's snapshot contains", () => {
    expect(advisories.flatMap((a) => provenanceProblems(a, snapshot))).toEqual([]);
  });

  it("rejects a quote missing from its snapshot, a missing snapshot, a foreign URL, and a verified advisory with none", () => {
    const a = advisories.find((x) => x.id === "github-workflow-dispatch-204-to-200")!;
    const p = a.provenance![0]!;
    const edited: Advisory = { ...a, provenance: [{ ...p, quote: "The endpoint keeps returning 204 No Content." }] };
    expect(provenanceProblems(edited, snapshot)).toEqual([`${a.id}: the quote from ${p.url} is not in its snapshot: "The endpoint keeps returning 204 No Content."`]);
    expect(provenanceProblems({ ...a, provenance: [{ ...p, sourceSha256: "0".repeat(64) }] }, snapshot)[0]).toMatch(/no snapshot/);
    expect(provenanceProblems({ ...a, provenance: [{ ...p, url: "https://example.com/other" }] }, snapshot)[0]).toMatch(/not one of its sources/);
    expect(provenanceProblems({ ...a, provenance: undefined }, snapshot)).toEqual([`${a.id}: verified, but has no provenance (a source fetched with the quote that backs it)`]);
    expect(provenanceProblems({ ...a, status: "unverified", provenance: undefined }, snapshot)).toEqual([]);
  });

  it("compares text the way a reader sees it: tags gone, entities decoded, quotes and whitespace folded", () => {
    const html = `<html><body><script>var x = 1;</script><p>The endpoint now returns <code>200&nbsp;OK</code> &mdash; with a body.</p><p>Next.</p></body></html>`;
    expect(pageText(html)).toBe("The endpoint now returns 200 OK - with a body.\nNext.");
    const a = { ...advisories.find((x) => x.id === "github-workflow-dispatch-204-to-200")! };
    const p = { ...a.provenance![0]!, quote: "now returns 200 OK — with a body." };
    expect(provenanceProblems({ ...a, provenance: [p] }, () => pageText(html))).toEqual([]);
  });
});
