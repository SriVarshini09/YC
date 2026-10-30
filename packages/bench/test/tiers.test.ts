import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DemotionsSchema, TierRegistrySchema, loadAdvisories, type Advisory } from "@shapi/core";
import { buildTierRegistry, latestRun, type BenchmarkRun } from "@shapi/bench";

// Execution plan U-04: the fix tier registry, earned from the latest benchmark run.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const advisories = loadAdvisories(path.join(repoRoot, "advisories"));

describe("the tier registry", () => {
  it("is in sync with the latest benchmark run and the founder's demotions (UPDATE_TIERS=1 rewrites packages/core/tiers.json)", () => {
    const file = path.join(repoRoot, "packages", "core", "tiers.json");
    const demotions = DemotionsSchema.parse(JSON.parse(readFileSync(path.join(here, "..", "datasets", "tier-demotions.json"), "utf8")));
    const registry = buildTierRegistry({ run: latestRun(path.join(here, "..", "results")), advisories, demotions });
    const generated = `${JSON.stringify(registry, null, 2)}\n`;
    if (process.env.UPDATE_TIERS || !existsSync(file)) writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
    expect(TierRegistrySchema.parse(registry).cells.length).toBeGreaterThan(0);
    // Every AUTO cell lists the benchmark instances that earned it.
    for (const c of registry.cells.filter((x) => x.tier === "AUTO")) expect(c.passes.length).toBeGreaterThanOrEqual(registry.autoAfter);
  });

  const advisory = (id: string, over: Partial<Advisory> = {}): Advisory => ({
    id,
    provider: "stripe",
    title: "t",
    summary: "s",
    endpoint: { method: "GET", path: "/v1/x" },
    changeClass: "field-rename",
    trigger: { fields: ["a"] },
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2027-01-01",
    severity: "high",
    migrationNote: "m",
    sources: ["https://stripe.com"],
    status: "verified",
    recipeId: "apply-fix",
    ...over,
  });
  const result = (id: string, advisoryId: string, over: Partial<BenchmarkRun["results"][number]> = {}): BenchmarkRun["results"][number] => ({
    id,
    incident: advisoryId,
    advisoryId,
    inScope: true,
    language: "TypeScript",
    evidenceFile: "a.ts",
    base: "affected",
    fixOutcome: "fixed",
    fixMethod: "recipe",
    fixOutOfScope: 0,
    ...over,
  });

  it("counts each instance toward the cell of the method that fixed it, lists every verified advisory's cell, and applies demotions", () => {
    const run: BenchmarkRun = {
      dataset: "d",
      shapiVersion: "0.3.1",
      runAt: "2026-10-30T00:00:00Z",
      results: [
        ...["1", "2", "3", "4", "5"].map((n) => result(`r${n}`, "a")),
        result("r6", "a", { fixMethod: "llm" }),
        result("r7", "b", { fixOutcome: "not-fixed", fixMethod: undefined }),
        result("r8", "a", { fixOutcome: undefined }),
      ],
    };
    const registry = buildTierRegistry({
      run,
      advisories: [advisory("a"), advisory("b", { provider: "github", changeClass: "status-code", recipeId: undefined }), advisory("c", { provider: "slack", status: "unverified" })],
      demotions: { "llm/stripe/field-rename": { tier: "ALERT", reason: "Claude rewrote unrelated code" } },
    });
    expect(registry.cells.map((c) => `${c.recipe}/${c.provider}/${c.changeClass} ${c.tier} ${c.passes.length}/${c.failures.length}`)).toEqual([
      "apply-fix/stripe/field-rename AUTO 5/0",
      "llm/github/status-code REVIEW 0/1",
      "llm/stripe/field-rename ALERT 1/0",
    ]);
    expect(registry.cells[0]!.passes).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(() => buildTierRegistry({ run, advisories: [advisory("a")], demotions: { "apply-fix/xero/auth": { tier: "REVIEW", reason: "r" } } })).toThrow(/no advisory/);
  });
});
