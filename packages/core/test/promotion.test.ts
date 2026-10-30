import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdvisorySchema, loadAdvisories, opensPullRequests, promotionCheck, type Advisory, type Provenance } from "../src/index";

// Execution plan C-03: the promotion rule, in code.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const draft: Advisory = { ...advisories.find((a) => a.id === "github-workflow-dispatch-204-to-200")!, status: "unverified", provenance: undefined, evidence: undefined };
const source = (url: string): Provenance => ({ url, quote: "The endpoint now returns 200 OK", sourceSha256: "a".repeat(64), fetchedAt: "2026-10-30T08:00:00Z" });
const evidence: NonNullable<Advisory["evidence"]> = {
  source: "canary",
  before: { observedAt: "2026-02-18T09:00:00Z", status: 204, shapeHash: "x" },
  after: { observedAt: "2026-02-19T09:00:00Z", status: 200, shapeHash: "y" },
  changes: ["status 204 -> 200"],
};

describe("promotion rule (C-03)", () => {
  it("needs provenance before anything else", () => {
    expect(promotionCheck(draft)).toEqual({ ok: false, missing: ["provenance: a source fetched with the quote that backs the advisory", "a witness (SHAPI saw the change) or a second source on another site"] });
    // A witness alone is not enough: someone has to have said it.
    expect(promotionCheck({ ...draft, evidence }).missing).toEqual(["provenance: a source fetched with the quote that backs the advisory"]);
  });

  it("then a witness, or a second source on another site", () => {
    const one = { ...draft, provenance: [source("https://github.blog/changelog/2026-02-19-workflow-dispatch")] };
    expect(promotionCheck(one).ok).toBe(false);
    // The same site twice is one source.
    expect(promotionCheck({ ...one, provenance: [...one.provenance, source("https://www.github.blog/changelog/other")] }).ok).toBe(false);
    expect(promotionCheck({ ...one, provenance: [...one.provenance, source("https://docs.github.com/en/rest/actions/workflows")] })).toEqual({ ok: true, missing: [] });
    expect(promotionCheck({ ...one, evidence }).ok).toBe(true);
    expect(promotionCheck(one, { witnessed: true }).ok).toBe(true);
  });

  it("only verified advisories open pull requests", () => {
    expect(opensPullRequests(draft)).toBe(false);
    expect(opensPullRequests({ ...draft, status: "verified" })).toBe(true);
    for (const a of advisories) expect(opensPullRequests(a)).toBe(a.status === "verified");
  });

  it("validates provenance entries", () => {
    expect(AdvisorySchema.safeParse({ ...draft, provenance: [source("https://docs.github.com/x")] }).success).toBe(true);
    expect(AdvisorySchema.safeParse({ ...draft, provenance: [{ ...source("https://docs.github.com/x"), sourceSha256: "nothex" }] }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...draft, provenance: [{ ...source("https://docs.github.com/x"), quote: "" }] }).success).toBe(false);
  });
});
