import { describe, expect, it } from "vitest";
import { AUTO_AFTER, DemotionsSchema, cellOf, earnTier, opensAsDraft, tierFor, type BenchmarkFix, type TierCell, type TierRegistry } from "@shapi/core";

// Execution plan U-04: fix tiers earned from benchmark passes and merge outcomes; a demotion can only lower one.
const cell: TierCell = { recipe: "apply-fix", provider: "stripe", changeClass: "field-rename" };
const fixed = (n: number, from = 0): BenchmarkFix[] => Array.from({ length: n }, (_, i) => ({ id: `i${from + i}`, outcome: "fixed" }));

describe("earnTier", () => {
  it("starts at REVIEW and earns AUTO after enough clean benchmark passes", () => {
    expect(earnTier(cell, { benchmark: [] })).toMatchObject({ tier: "REVIEW", passes: [], reasons: [`0 of the ${AUTO_AFTER} benchmark passes AUTO needs`] });
    expect(earnTier(cell, { benchmark: fixed(AUTO_AFTER - 1) }).tier).toBe("REVIEW");
    const auto = earnTier(cell, { benchmark: fixed(AUTO_AFTER) });
    expect(auto).toMatchObject({ tier: "AUTO", passes: ["i0", "i1", "i2", "i3", "i4"], failures: [] });
  });

  it("keeps a cell at REVIEW when any instance in the run failed or edited outside the predicted lines; errors don't count", () => {
    expect(earnTier(cell, { benchmark: [...fixed(6), { id: "x", outcome: "partial" }] })).toMatchObject({ tier: "REVIEW", failures: ["x"] });
    expect(earnTier(cell, { benchmark: [...fixed(6), { id: "y", outcome: "fixed", outOfScope: 1 }] })).toMatchObject({ tier: "REVIEW", failures: ["y"] });
    expect(earnTier(cell, { benchmark: [...fixed(5), { id: "z", outcome: "error" }] }).tier).toBe("AUTO");
  });

  it("caps auth and scope changes at REVIEW", () => {
    expect(earnTier({ ...cell, changeClass: "auth" }, { benchmark: fixed(9) })).toMatchObject({ tier: "REVIEW", reasons: expect.arrayContaining(["auth changes always get a person's review"]) });
  });

  it("lowers a tier one step when PRs are closed unmerged more than merged", () => {
    expect(earnTier(cell, { benchmark: fixed(5), prs: { merged: 1, closed: 3 } }).tier).toBe("REVIEW");
    expect(earnTier(cell, { benchmark: [], prs: { merged: 0, closed: 3 } })).toMatchObject({ tier: "ALERT", reasons: expect.arrayContaining(["3 fix PRs closed without merging, 0 merged"]) });
    expect(earnTier(cell, { benchmark: [], prs: { merged: 3, closed: 3 } }).tier).toBe("REVIEW");
    expect(earnTier(cell, { benchmark: [], prs: { merged: 0, closed: 2 } }).tier).toBe("REVIEW");
  });

  it("lets a demotion lower a tier but never raise it; the demotion file cannot even say AUTO", () => {
    expect(earnTier(cell, { benchmark: fixed(5), demotion: { tier: "REVIEW", reason: "a customer reported a bad fix" } })).toMatchObject({ tier: "REVIEW", reasons: expect.arrayContaining(["demoted: a customer reported a bad fix"]) });
    expect(earnTier(cell, { benchmark: [], demotion: { tier: "ALERT", reason: "r" } }).tier).toBe("ALERT");
    expect(DemotionsSchema.safeParse({ "apply-fix/stripe/field-rename": { tier: "AUTO", reason: "r" } }).success).toBe(false);
  });

  it("puts a fix in Claude's cell when Claude wrote any of it, and opens REVIEW as a draft", () => {
    expect(cellOf({ recipeId: "apply-fix", provider: "stripe", changeClass: "field-rename" })).toEqual(cell);
    expect(cellOf({ recipeId: "apply-fix", provider: "stripe", changeClass: "field-rename" }, "llm").recipe).toBe("llm");
    expect(cellOf({ provider: "stripe", changeClass: "field-rename" }).recipe).toBe("llm");
    expect([opensAsDraft("REVIEW"), opensAsDraft("AUTO")]).toEqual([true, false]);
  });
});

describe("tierFor", () => {
  const registry: TierRegistry = {
    benchmark: { dataset: "d", shapiVersion: "0", runAt: "2026-10-30T00:00:00Z" },
    autoAfter: AUTO_AFTER,
    cells: [{ ...cell, benchmark: fixed(5), tier: "AUTO", passes: [], failures: [], reasons: [] }],
  };

  it("uses the registry's evidence and the account's own merge outcomes; an unlisted cell is REVIEW", () => {
    expect(tierFor(cell, undefined, registry).tier).toBe("AUTO");
    expect(tierFor(cell, { merged: 0, closed: 3 }, registry).tier).toBe("REVIEW");
    expect(tierFor({ ...cell, provider: "github" }, undefined, registry).tier).toBe("REVIEW");
  });
});
