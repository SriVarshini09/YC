import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { RECIPES, runRecipe } from "@shapi/repair";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const now = new Date("2026-10-21");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-recipe-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Scan a directory and return the call sites the GitHub advisory affects. */
function affected(dir: string, adv: Advisory = advisory): LockedCallSite[] {
  const lock = createApiLock(extractCallSites(dir), "test");
  return matchAdvisories(lock, [adv], { now }).affected.map((f) => f.callSite);
}

/** Write one source file into a fresh dir and return its single affected call site. */
function fixture(name: string, source: string): { dir: string; site: LockedCallSite } {
  const dir = path.join(tmp, name);
  cpSync(path.join(root, "fixtures", "demo-ts", "package.json"), path.join(dir, "package.json"));
  writeFileSync(path.join(dir, "app.ts"), source);
  const [site] = affected(dir);
  if (!site) throw new Error(`no affected call site in ${name}`);
  return { dir, site };
}

const URL = "`https://api.github.com/repos/${o}/${r}/actions/workflows/${w}/dispatches`";

describe("status-code-accept-set on fixtures/demo-ts", () => {
  const demo = path.join(tmp, "demo");
  cpSync(path.join(root, "fixtures", "demo-ts"), demo, { recursive: true });
  const [site] = affected(demo);
  const file = path.join(demo, "src", "deploy.ts");
  const before = readFileSync(file, "utf8");
  const outcome = runRecipe(RECIPES, advisory, site!, before);

  it("rewrites the 204 check to accept 200 and 204", () => {
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.recipe).toBe("status-code-accept-set");
    expect(outcome.change.file).toBe("src/deploy.ts");
    expect(outcome.change.after).toContain("if (![200, 204].includes(res.status)) {");
    expect(outcome.change.after).not.toContain("res.status !== 204");
    expect(outcome.change.notes).toEqual(["src/deploy.ts:22 `res.status !== 204` → `![200, 204].includes(res.status)`"]);
    // nothing else in the file changes
    expect(outcome.change.after.replace("![200, 204].includes(res.status)", "res.status !== 204")).toBe(before);
  });

  it("leaves the call site no longer affected when the repo is scanned again", () => {
    if (outcome.status !== "applied") throw new Error(outcome.status);
    writeFileSync(file, outcome.change.after);
    expect(affected(demo)).toEqual([]);
  });
});

describe("status-code-accept-set forms", () => {
  const run = (name: string, source: string) => {
    const { site } = fixture(name, source);
    return runRecipe(RECIPES, advisory, site, source);
  };
  const after = (o: ReturnType<typeof run>) => (o.status === "applied" ? o.change.after : `<${o.status}>`);

  it("handles === with the literal on either side", () => {
    const src = `export async function f(o: string, r: string, w: string) {\n  const res = await fetch(${URL}, { method: "POST" });\n  return 204 === res.status;\n}\n`;
    expect(after(run("eq", src))).toContain("return [200, 204].includes(res.status);");
  });

  it("adds missing cases to a switch on the status", () => {
    const src = `export async function f(o: string, r: string, w: string) {\n  const res = await fetch(${URL}, { method: "POST" });\n  switch (res.status) {\n    case 204:\n      return true;\n    default:\n      return false;\n  }\n}\n`;
    expect(after(run("switch", src))).toContain("    case 200:\n    case 204:\n      return true;");
  });

  it("extends an includes() list", () => {
    const src = `export async function f(o: string, r: string, w: string) {\n  const res = await fetch(${URL}, { method: "POST" });\n  return [201, 204].includes(res.status);\n}\n`;
    expect(after(run("includes", src))).toContain("return [200, 201, 204].includes(res.status);");
  });

  it("follows destructured status and then-callbacks", () => {
    const destructured = `export async function f(o: string, r: string, w: string) {\n  const { status } = await fetch(${URL}, { method: "POST" });\n  if (status != 204) throw new Error("x");\n}\n`;
    expect(after(run("destructured", destructured))).toContain("if (![200, 204].includes(status)) throw");
    const then = `export function f(o: string, r: string, w: string) {\n  return fetch(${URL}, { method: "POST" }).then((res) => res.status === 204);\n}\n`;
    expect(after(run("then", then))).toContain(".then((res) => [200, 204].includes(res.status));");
  });

  it("reports why it did not apply", () => {
    const src = `export async function f(o: string, r: string, w: string) {\n  const res = await fetch(${URL}, { method: "POST" });\n  if (res.status !== 204) throw new Error("x");\n}\n`;
    const { site } = fixture("reasons", src);
    expect(runRecipe(RECIPES, { ...advisory, recipeId: undefined }, site, src)).toMatchObject({ status: "no-recipe" });
    expect(runRecipe(RECIPES, advisory, { ...site, line: site.line + 1 }, src)).toMatchObject({ status: "call-not-found" });
    expect(runRecipe(RECIPES, { ...advisory, trigger: { statusCodes: [404], newStatusCodes: [410] } }, site, src)).toMatchObject({ status: "no-change" });
  });
});
