import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Advisory, Finding, LockedCallSite } from "@shapi/core";
import { okapiRow, okapiTable, removedLines, type OkapiPr } from "@shapi/bench";

const benchRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const advisoryIds = new Set(
  readdirSync(path.join(benchRoot, "..", "..", "advisories"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
);

const pr: OkapiPr = {
  repo: "acme/app",
  number: 3,
  url: "https://github.com/acme/app/pull/3",
  title: "fix(gemini): move off gemini-2.0-flash",
  merged: false,
  base: "a".repeat(40),
  provider: "google",
  kind: "retirement",
  files: [{ path: "src/gemini.js", removedLines: [26] }],
  okapiTarget: "gemini-3.6-flash",
  shapiAdvisories: ["google-gemini-2-0-flash-shutdown"],
  shapiTarget: "gemini-3.6-flash",
};
const finding = (id: string, file: string, line: number) => ({ advisory: { id } as Advisory, callSite: { file, line } as LockedCallSite, reasons: [] }) as Finding;
const empty = { affected: [], possible: [], exposed: [] };

describe("Okapi head-to-head (P-04)", () => {
  it("reads the base-commit lines a diff removes or replaces", () => {
    const patch = "@@ -24,4 +24,4 @@ const a = 1;\n const b = 2;\n-const MODEL = 'old';\n+const MODEL = 'new';\n const c = 3;\n@@ -140,3 +140,3 @@\n-  x\n+  y\n z";
    expect(removedLines(patch)).toEqual([25, 140]);
    expect(removedLines("")).toEqual([]);
  });

  it("scores SHAPI's finding for the change, in Okapi's file or another, and the fix target", () => {
    expect(okapiRow(pr, { ...empty, affected: [finding("google-gemini-2-0-flash-shutdown", "src/gemini.js", 141)] })).toMatchObject({
      verdict: "affected",
      advisoryPresent: true,
      sameFile: true,
      findings: ["src/gemini.js:141 google-gemini-2-0-flash-shutdown"],
      fixAgreement: "same target",
    });
    expect(okapiRow(pr, { ...empty, possible: [finding("google-gemini-2-0-flash-shutdown", "src/other.js", 9)] })).toMatchObject({ verdict: "possible", sameFile: false });
    expect(okapiRow(pr, empty)).toMatchObject({ verdict: "missed", findings: [] });
    expect(okapiRow({ ...pr, shapiTarget: "gemini-3.1-flash" }, empty).fixAgreement).toBe("different target");
    expect(okapiRow({ ...pr, shapiTarget: null }, empty).fixAgreement).toBe("no SHAPI target");
  });

  it("tells a change SHAPI has no advisory for from a language it does not scan, and lists other findings in Okapi's files", () => {
    const none = { ...pr, shapiAdvisories: [], shapiTarget: null };
    const reddit = finding("reddit-logged-out-json-403", "src/gemini.js", 49);
    expect(okapiRow(none, { ...empty, affected: [reddit, finding("reddit-logged-out-json-403", "src/elsewhere.js", 1)] })).toMatchObject({
      verdict: "no advisory",
      fixAgreement: "no SHAPI advisory",
      otherFindings: ["src/gemini.js:49 reddit-logged-out-json-403"],
    });
    // Possible findings are not claimed as findings Okapi missed.
    expect(okapiRow(none, { ...empty, possible: [reddit] }).otherFindings).toEqual([]);
    expect(okapiRow({ ...none, files: [{ path: "app/Api.kt", removedLines: [3] }] }, empty).verdict).toBe("not scanned");
    expect(okapiRow(pr, undefined, "download failed: 404")).toMatchObject({ verdict: "missed", error: "download failed: 404" });
  });

  it("writes one table row per PR, with the commit and the verdict", () => {
    const row = okapiRow(pr, { ...empty, affected: [finding("google-gemini-2-0-flash-shutdown", "src/gemini.js", 141)] });
    const table = okapiTable([pr], [row]).split("\n");
    expect(table).toHaveLength(3);
    expect(table[2]).toBe(
      "| [acme/app#3](https://github.com/acme/app/pull/3) | retirement: fix(gemini): move off gemini-2.0-flash | [`aaaaaaa`](https://github.com/acme/app/tree/" +
        "a".repeat(40) +
        ") | yes: `google-gemini-2-0-flash-shutdown` | affected: `src/gemini.js:141 google-gemini-2-0-flash-shutdown` | same target (SHAPI gemini-3.6-flash, Okapi gemini-3.6-flash) | none |",
    );
  });

  it("the dataset holds every public Okapi PR, with real commits and SHAPI advisories that exist", () => {
    const dataset = JSON.parse(readFileSync(path.join(benchRoot, "datasets", "okapi-prs.json"), "utf8")) as { prs: OkapiPr[] };
    expect(dataset.prs).toHaveLength(14);
    expect(new Set(dataset.prs.map((p) => p.url)).size).toBe(14);
    for (const p of dataset.prs) {
      expect(p.base, p.url).toMatch(/^[0-9a-f]{40}$/);
      expect(p.url).toBe(`https://github.com/${p.repo}/pull/${p.number}`);
      expect(p.files.length, p.url).toBeGreaterThan(0);
      for (const id of p.shapiAdvisories) expect(advisoryIds.has(id), id).toBe(true);
      expect(Boolean(p.shapiTarget), p.url).toBe(p.shapiTarget !== null && p.shapiAdvisories.length > 0);
    }
  });

  it("the published results match the dataset and say what the table says", () => {
    const dir = path.join(benchRoot, "results", "okapi");
    const [version] = readdirSync(dir);
    const [file] = readdirSync(path.join(dir, version!));
    const results = JSON.parse(readFileSync(path.join(dir, version!, file!), "utf8")) as { summary: Record<string, number>; rows: { pr: string; verdict: string }[] };
    expect(results.rows).toHaveLength(14);
    expect(results.summary).toMatchObject({ prs: 14, repositories: 9, errors: 0 });
    const doc = readFileSync(path.join(benchRoot, "OKAPI.md"), "utf8");
    for (const row of results.rows) expect(doc).toContain(`[${row.pr}](`);
  });
});
