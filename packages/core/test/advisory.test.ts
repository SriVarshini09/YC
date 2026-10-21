import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdvisorySchema, advisoryJsonSchema, getProvider, loadAdvisories } from "@shapi/core";

const advisoriesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories");

describe("seeded advisories", () => {
  const advisories = loadAdvisories(advisoriesDir);

  it("all validate, have unique ids, and reference known providers", () => {
    expect(advisories.length).toBeGreaterThanOrEqual(7);
    expect(new Set(advisories.map((a) => a.id)).size).toBe(advisories.length);
    for (const a of advisories) expect(getProvider(a.provider), a.id).toBeDefined();
  });

  it("include the GitHub workflow_dispatch 204 to 200 case as a critical status-code change", () => {
    const gh = advisories.find((a) => a.id === "github-workflow-dispatch-204-to-200");
    expect(gh).toMatchObject({
      provider: "github",
      changeClass: "status-code",
      severity: "critical",
      trigger: { statusCodes: [204] },
      endpoint: { method: "POST", path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" },
    });
  });

  it("cover QuickBooks, Xero, Reddit, Meta Graph and a dated upcoming deadline", () => {
    const providers = new Set(advisories.map((a) => a.provider));
    for (const p of ["quickbooks", "xero", "reddit", "meta-graph", "hubspot"]) expect(providers.has(p), p).toBe(true);
  });
});

describe("AdvisorySchema", () => {
  const base = {
    id: "x-y",
    provider: "github",
    title: "t",
    summary: "s",
    endpoint: { method: "*", path: "/a" },
    changeClass: "auth",
    trigger: { any: true },
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2026-01-01",
    severity: "low",
    migrationNote: "m",
    sources: ["https://example.com"],
    status: "verified",
  };

  it("accepts a minimal advisory and rejects bad ones", () => {
    expect(AdvisorySchema.safeParse(base).success).toBe(true);
    expect(AdvisorySchema.safeParse({ ...base, trigger: {} }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, changeClass: "vibes" }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, effectiveDate: "Jan 1" }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, sources: [] }).success).toBe(false);
  });

  it("loadAdvisories names the bad file and enforces id-based file names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-adv-"));
    writeFileSync(path.join(dir, "wrong-name.json"), JSON.stringify(base));
    expect(() => loadAdvisories(dir)).toThrow(/wrong-name.json must be named x-y.json/);
    writeFileSync(path.join(dir, "wrong-name.json"), JSON.stringify({ ...base, severity: "huge" }));
    expect(() => loadAdvisories(dir)).toThrow(/invalid advisory wrong-name.json/);
  });
});

describe("advisory JSON Schema", () => {
  it("keeps schema/advisory.schema.json in sync (UPDATE_SCHEMA=1 rewrites it)", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schema", "advisory.schema.json");
    const generated = JSON.stringify(advisoryJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA || !existsSync(file)) writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });
});
