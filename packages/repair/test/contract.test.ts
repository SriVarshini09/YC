import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore, inferShape, providerSalt } from "@shapi/shapes";
import { loadRecording, replay } from "@shapi/canary";
import { RECIPES, generateContractTest, runRecipe, runTestFile, synthesizeBody } from "@shapi/repair";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-contract-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const store = ShapeStore.open(":memory:");
const replayed = replay(loadRecording(path.join(root, "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json")), store, "test");
store.close();
const before = replayed.before!.shape;
const after = replayed.after.shape;

describe("synthesizeBody", () => {
  const salt = providerSalt("github", "test");

  it("rebuilds a body with the same structure as the shape it came from", () => {
    const original = {
      total_count: 2,
      workflow_runs: [{ id: 9, conclusion: "success", created_at: "2026-10-01T12:00:00Z", head: { sha: "a1b2c3d4e5f6a1b2c3d4e5f6" }, tags: ["x"] }],
      next: null,
    };
    const shape = inferShape({ status: 200, headers: {}, body: JSON.stringify(original) }, { salt });
    const synthetic = synthesizeBody(shape);
    const again = inferShape({ status: 200, headers: {}, body: JSON.stringify(synthetic) }, { salt });
    expect(again.body.fields.map((f) => [f.path, f.types.filter((t) => t !== "null")])).toEqual(
      shape.body.fields.map((f) => [f.path, f.types.filter((t) => t !== "null")]),
    );
    expect(JSON.stringify(synthetic)).not.toContain("success");
  });

  it("returns null for empty bodies and handles array roots", () => {
    expect(synthesizeBody(before)).toBeNull();
    const shape = inferShape({ status: 200, headers: {}, body: JSON.stringify([{ id: 1 }]) }, { salt });
    expect(synthesizeBody(shape)).toEqual([{ id: 1 }]);
  });
});

describe("generateContractTest on fixtures/demo-ts", () => {
  const dir = path.join(tmp, "demo");
  cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
  const lock = createApiLock(extractCallSites(dir), "test");
  const site = matchAdvisories(lock, [advisory]).affected[0]!.callSite;
  const sourceText = readFileSync(path.join(dir, site.file), "utf8");
  const test = generateContractTest({ callSite: site, advisory, before, after, sourceText });

  it("writes a vitest file that calls the enclosing exported function with typed arguments", () => {
    expect(test.status).toBe("generated");
    if (test.status !== "generated") return;
    expect(test.file).toBe("test/shapi/github-workflow-dispatch-204-to-200.test.ts");
    expect(test.functionName).toBe("triggerDeploy");
    expect(test.content).toContain('import { triggerDeploy } from "../../src/deploy";');
    expect(test.content).toContain('return triggerDeploy({ "owner": "shapi-owner", "repo": "shapi-repo", "workflow": "shapi-workflow", "ref": "shapi-ref" }, "shapi-token");');
    expect(test.content).toContain('{ name: "before (204)", status: 204, headers: {}, body: null }');
    expect(test.content).toContain('"workflow_run_id":1');
  });

  it("fails on the current code and passes once the recipe is applied", () => {
    if (test.status !== "generated") throw new Error(test.status);
    mkdirSync(path.join(dir, "test", "shapi"), { recursive: true });
    writeFileSync(path.join(dir, test.file), test.content);

    const broken = runTestFile(dir, test.file);
    expect(broken.passed).toBe(false);
    expect(broken.output).toContain("deploy dispatch failed with 200");
    expect(broken.output).toMatch(/1 failed \| 1 passed/);

    const fix = runRecipe(RECIPES, advisory, site, sourceText);
    if (fix.status !== "applied") throw new Error(fix.status);
    writeFileSync(path.join(dir, site.file), fix.change.after);
    const fixed = runTestFile(dir, test.file);
    expect(fixed.passed).toBe(true);
    expect(fixed.output).toMatch(/2 passed/);
  }, 120_000);

  it("explains call sites it cannot test", () => {
    expect(generateContractTest({ callSite: { ...site, client: "superagent" }, advisory, before, after, sourceText })).toMatchObject({
      status: "unsupported",
      reason: "contract tests support fetch, node-fetch, ky, axios, got and SDK call sites; this one uses superagent",
    });
    const internal = sourceText.replace("export async function triggerDeploy", "async function triggerDeploy");
    expect(generateContractTest({ callSite: site, advisory, before, after, sourceText: internal })).toEqual({
      status: "unsupported",
      reason: "the call site is not inside an exported function",
    });
  });
});
