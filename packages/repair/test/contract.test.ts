import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("generateContractTest: generated text", () => {
  const dir = path.join(tmp, "text");
  cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
  const site = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory]).affected[0]!.callSite;
  const sourceText = readFileSync(path.join(dir, site.file), "utf8");

  it("keeps a title or endpoint with a newline inside its comment", () => {
    const test = generateContractTest({ callSite: { ...site, endpoint: "/repos/{}\nthrow 1;" }, advisory: { ...advisory, title: "two\nlines" }, before, after, sourceText });
    if (test.status !== "generated") throw new Error(test.status);
    const [first, second, third] = test.content.split("\n");
    expect(first).toBe("// Generated by SHAPI for advisory github-workflow-dispatch-204-to-200: two lines");
    expect(second).toMatch(/^\/\/ Call site: src\/deploy\.ts:\d+ \(POST \/repos\/\{\} throw 1;, via fetch\)$/);
    expect(third!.startsWith("//")).toBe(true);
  });

  it("imports a function exported under another name by that name", () => {
    const aliased = sourceText.replace("export async function triggerDeploy", "async function triggerDeploy") + "export { triggerDeploy as dispatchDeploy };\n";
    const test = generateContractTest({ callSite: site, advisory, before, after, sourceText: aliased });
    if (test.status !== "generated") throw new Error(test.status);
    expect(test.content).toContain('import { dispatchDeploy } from "../../src/deploy";');
    expect(test.content).toContain("return dispatchDeploy(");
  });

  it("applies every rename on a path: a renamed parent and a renamed leaf", () => {
    const source = `export async function emails(token: string) {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  return body.results.map((e: any) => e.folderId);
}
`;
    const hs = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "hubspot-marketing-emails-folderid-removed")!;
    const renamed = { ...hs, fix: { fields: [{ from: "results", to: "items" }, { from: "folderId", to: "folderIdV2" }] } };
    const callSite = { ...site, file: "src/app.ts", line: 2, column: 21, endpoint: "/marketing/v3/emails", method: "GET" as const, provider: "hubspot", surface: { ...site.surface, fields: ["results[].folderId"] } };
    const test = generateContractTest({ callSite, advisory: renamed, sourceText: source });
    if (test.status !== "generated") throw new Error(test.status);
    expect(test.content).toContain('{ name: "new", body: {"items":[{"folderIdV2":"shapi text"}]} }');
  });
});

describe("synthesizeBody: escaped keys", () => {
  it("builds a dotted or bracketed key as one key", () => {
    const salt = providerSalt("x", "test");
    const shape = inferShape({ status: 200, headers: {}, body: JSON.stringify({ "a.b": 1, "filter[name]": "x" }) }, { salt });
    expect(synthesizeBody(shape)).toEqual({ "a.b": 1, "filter[name]": "shapi_value" });
  });
});

describe("generateContractTest: the test file type-checks", () => {
  it("compiles under tsc --strict for each kind of test, so the PR passes the repo's own typecheck", () => {
    const dir = path.join(tmp, "tsc");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const all = loadAdvisories(path.join(root, "advisories"));
    const byId = (id: string) => all.find((a) => a.id === id)!;
    const cases: [string, string, string][] = [
      ["recorded", "github-workflow-dispatch-204-to-200", `export async function deploy(o: string, r: string, w: string): Promise<void> {\n  const res = await fetch(\`https://api.github.com/repos/\${o}/\${r}/actions/workflows/\${w}/dispatches\`, { method: "POST" });\n  if (res.status !== 204) throw new Error("x");\n}\n`],
      ["same-result", "hubspot-marketing-emails-folderid-removed", `export async function emailFolders(token: string) {\n  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: token } });\n  const body = await res.json();\n  return body.results.map((e: { folderId: string }) => e.folderId);\n}\n`],
      ["request", "quickbooks-minorversion-below-75-ignored", `export async function invoices(realmId: string) {\n  const res = await fetch(\`https://quickbooks.api.intuit.com/v3/company/\${realmId}/query?query=x&minorversion=65\`);\n  return res.json();\n}\n`],
    ];
    for (const [kind, , source] of cases) writeFileSync(path.join(dir, "src", `${kind}.ts`), source);
    const lock = createApiLock(extractCallSites(dir), "test");
    for (const [kind, id, source] of cases) {
      const adv = byId(id);
      const site = matchAdvisories(lock, [adv], { now: new Date("2026-10-23") }).affected.find((f) => f.callSite.file === `src/${kind}.ts`)!.callSite;
      const test = generateContractTest({ callSite: site, advisory: adv, before, after, sourceText: source, file: `test/shapi/${kind}.test.ts` });
      if (test.status !== "generated") throw new Error(`${kind}: ${test.reason}`);
      expect(test.kind).toBe(kind);
      mkdirSync(path.join(dir, "test", "shapi"), { recursive: true });
      writeFileSync(path.join(dir, test.file), test.content);
    }
    const compilerOptions = { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022", "dom"], types: ["node"], skipLibCheck: true };
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src", "test"] }));
    const run = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "lib", "tsc.js"), "-p", dir, "--pretty", "false"], { encoding: "utf8" });
    expect(`${run.stdout}${run.stderr}`.trim()).toBe("");
  }, 60_000);
});
