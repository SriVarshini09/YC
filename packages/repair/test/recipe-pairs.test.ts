import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdvisorySchema, createApiLock, loadAdvisories, matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";
import { RECIPES, repairCallSite, runRecipe } from "@shapi/repair";
import { runPythonRecipe } from "../src/python/recipes";
import { pythonCommand } from "../src/runner";

// Execution plan C-07: behaviour-preserving recipe pairs. A model swap with the parameter the new model needs, and a
// version bump with the field it renamed, each applied as one fix.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisories = loadAdvisories(path.join(root, "advisories"));
const now = new Date("2026-10-20");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-pairs-"));
const sandboxes: string[] = [];
afterAll(() => {
  for (const d of [tmp, ...sandboxes]) rmSync(d, { recursive: true, force: true });
});

/** The OpenAI legacy-model advisory, with a model swap that also renames the token limit (a fixture, not advisory data). */
const modelSwap: Advisory = AdvisorySchema.parse({
  ...advisories.find((a) => a.id === "openai-legacy-gpt-o-series-shutdown-2026-10-23")!,
  recipeId: "apply-fix",
  fix: { body: [{ field: "model", values: [{ from: "gpt-4", to: "gpt-5.6-sol" }] }, { field: "max_tokens", rename: "max_completion_tokens" }] },
});

let n = 0;
function repo(source: string, advisory: Advisory, extra: Record<string, string> = {}): { dir: string; sites: LockedCallSite[] } {
  const dir = path.join(tmp, `r${++n}`);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  cpSync(path.join(root, "fixtures", "demo-ts", "package.json"), path.join(dir, "package.json"));
  writeFileSync(path.join(dir, "src", "app.ts"), source);
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const sites = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory], { now }).affected.map((f) => f.callSite);
  return { dir, sites };
}

const FETCH = [
  "export async function ask(question: string): Promise<string> {",
  '  const res = await fetch("https://api.openai.com/v1/chat/completions", {',
  '    method: "POST",',
  '    headers: { "content-type": "application/json", authorization: "Bearer k" },',
  '    body: JSON.stringify({ model: "gpt-4", max_tokens: 100, messages: [{ role: "user", content: question }] }),',
  "  });",
  "  const data = await res.json();",
  "  return data.choices[0].message.content;",
  "}",
  "",
].join("\n");

describe("a model swap with the parameter the new model needs", () => {
  it("changes the model and renames the token limit in one fix", () => {
    const { sites } = repo(FETCH, modelSwap);
    const out = runRecipe(RECIPES, modelSwap, sites[0]!, FETCH);
    if (out.status !== "applied") throw new Error(out.reason);
    expect(out.change.after).toContain('JSON.stringify({ model: "gpt-5.6-sol", max_completion_tokens: 100, messages:');
    expect(out.change.notes).toHaveLength(2);
  });

  it("is proven by a contract test that rejects the old model or the old parameter name (fetch)", async () => {
    const { dir, sites } = repo(FETCH, modelSwap);
    const result = await repairCallSite({ repoDir: dir, advisory: modelSwap, callSite: sites[0]!, recipes: RECIPES });
    if (result.sandbox) sandboxes.push(result.sandbox);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("fixed");
    expect(result.baseline?.output).toMatch(/SHAPI breakage: ask\(\) sent the retired request/);
    expect(result.test?.content).toContain('"max_tokens" in req.body');
  }, 60_000);

  it("works the same through the OpenAI SDK, whose argument is the body", async () => {
    const source = [
      'import OpenAI from "openai";',
      "const client = new OpenAI();",
      "export async function ask(question: string): Promise<string | null> {",
      '  const r = await client.chat.completions.create({ model: "gpt-4", max_tokens: 5, messages: [{ role: "user", content: question }] });',
      "  return r.choices[0].message.content;",
      "}",
      "",
    ].join("\n");
    const { dir, sites } = repo(source, modelSwap, { "node_modules/openai/package.json": '{"name":"openai","version":"6.0.0","main":"index.js"}', "node_modules/openai/index.js": "module.exports = class OpenAI {};" });
    expect(sites).toHaveLength(1);
    const result = await repairCallSite({ repoDir: dir, advisory: modelSwap, callSite: sites[0]!, recipes: RECIPES });
    if (result.sandbox) sandboxes.push(result.sandbox);
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("fixed");
    expect(result.changes[0]!.after).toContain('create({ model: "gpt-5.6-sol", max_completion_tokens: 5, messages:');
  }, 60_000);
});

describe("a version bump with the field it renamed", () => {
  it("moves the version and reads the new field name, falling back to the old one, in one fix", () => {
    const bump: Advisory = AdvisorySchema.parse({
      id: "meta-graph-pair-fixture",
      provider: "meta-graph",
      title: "v21.0 sunset; the field is renamed in v26.0",
      summary: "s",
      endpoint: { method: "*", path: "/v21.0/**" },
      changeClass: "version-sunset",
      trigger: { any: true },
      firstObserved: null,
      publishedNotice: null,
      effectiveDate: "2026-11-01",
      severity: "high",
      migrationNote: "m",
      recipeId: "apply-fix",
      fix: { path: { from: "/v21.0/", to: "/v26.0/" }, fields: [{ from: "insights_count", to: "insight_count" }] },
      sources: ["https://developers.facebook.com/docs/graph-api/changelog"],
      status: "verified",
    });
    const source = [
      "export async function count(page: string): Promise<number> {",
      "  const res = await fetch(`https://graph.facebook.com/v21.0/${page}?fields=insights_count`);",
      "  const data = await res.json();",
      "  return data.insights_count;",
      "}",
      "",
    ].join("\n");
    const { sites } = repo(source, bump);
    const out = runRecipe(RECIPES, bump, sites[0]!, source);
    if (out.status !== "applied") throw new Error(out.reason);
    expect(out.change.after).toContain("https://graph.facebook.com/v26.0/${page}");
    expect(out.change.after).toContain("(data.insight_count ?? data.insights_count)");
  });
});

describe("the same pair in Python", () => {
  const hasPython = spawnSync(pythonCommand(), ["--version"]).status === 0;
  const hasRequests = hasPython && spawnSync(pythonCommand(), ["-c", "import requests"]).status === 0;
  beforeAll(() => loadPythonParser());

  function pyRepo(source: string): { dir: string; sites: LockedCallSite[] } {
    const dir = path.join(tmp, `py${++n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ask.py"), source);
    const sites = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [modelSwap], { now }).affected.map((f) => f.callSite);
    return { dir, sites };
  }

  it("changes the model and renames the token limit in an SDK call's keyword arguments", () => {
    const source = [
      "from openai import OpenAI",
      "client = OpenAI()",
      "",
      "def ask(question):",
      '    r = client.chat.completions.create(model="gpt-4", max_tokens=5, messages=[{"role": "user", "content": question}])',
      "    return r.choices[0].message.content",
      "",
    ].join("\n");
    const { sites } = pyRepo(source);
    const out = runPythonRecipe(modelSwap, sites[0]!, source);
    if (out.status !== "applied") throw new Error(out.reason);
    expect(out.change.after).toContain('create(model="gpt-5.6-sol", max_completion_tokens=5, messages=');
  });

  it.runIf(hasRequests)("is proven by a Python contract test that reads the JSON body (requests)", async () => {
    const source = [
      "import requests",
      "",
      "def ask(question):",
      '    r = requests.post("https://api.openai.com/v1/chat/completions", json={"model": "gpt-4", "max_tokens": 5, "messages": [{"role": "user", "content": question}]})',
      '    return r.json().get("id")',
      "",
    ].join("\n");
    const { dir, sites } = pyRepo(source);
    const result = await repairCallSite({ repoDir: dir, advisory: modelSwap, callSite: sites[0]!, recipes: RECIPES });
    expect(result.reason).toBeUndefined();
    expect(result.status).toBe("fixed");
    expect(result.baseline?.output).toMatch(/SHAPI breakage: ask\(\) sends the retired request POST .* \(model: gpt-4\)/);
    expect(result.changes[0]!.after).toContain('json={"model": "gpt-5.6-sol", "max_completion_tokens": 5, "messages"');
  }, 60_000);
});
