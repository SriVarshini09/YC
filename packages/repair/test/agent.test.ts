import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore } from "@shapi/shapes";
import { loadRecording, replay } from "@shapi/canary";
import { RECIPES, claudeFixer, repairCallSite, runRecipe, type FixRequest, type LlmFixer } from "@shapi/repair";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-agent-"));
const sandboxes: string[] = [];
afterAll(() => {
  for (const d of [tmp, ...sandboxes]) rmSync(d, { recursive: true, force: true });
});

const store = ShapeStore.open(":memory:");
const replayed = replay(loadRecording(path.join(root, "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json")), store, "test");
store.close();
const shapes = { before: replayed.before!.shape, after: replayed.after.shape };

function demoRepo(name: string) {
  const dir = path.join(tmp, name);
  cpSync(path.join(root, "fixtures", "demo-ts"), dir, { recursive: true });
  const callSite = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory]).affected[0]!.callSite;
  return { dir, callSite, original: readFileSync(path.join(dir, callSite.file), "utf8") };
}

async function repair(dir: string, callSite: ReturnType<typeof demoRepo>["callSite"], opts: { llm?: LlmFixer; noRecipe?: boolean } = {}) {
  const result = await repairCallSite({
    repoDir: dir,
    advisory: opts.noRecipe ? { ...advisory, recipeId: undefined } : advisory,
    callSite,
    ...shapes,
    recipes: RECIPES,
    llm: opts.llm,
  });
  if (result.sandbox) sandboxes.push(result.sandbox);
  return result;
}

const fixedText = (original: string) => original.replace("res.status !== 204", "res.status !== 200 && res.status !== 204");

describe("repairCallSite", () => {
  it("fixes the demo call site with the recipe, test-first, without touching the repo", async () => {
    const { dir, callSite, original } = demoRepo("recipe");
    const result = await repair(dir, callSite);
    expect(result.status).toBe("fixed");
    expect(result.method).toBe("recipe");
    expect(result.baseline?.passed).toBe(false);
    expect(result.attempts.map((a) => `${a.method}:${a.outcome}`)).toEqual(["recipe:passed"]);
    expect(result.changes.map((c) => c.file)).toEqual(["src/deploy.ts", "test/shapi/github-workflow-dispatch-204-to-200.test.ts"]);
    expect(result.changes[0]!.after).toContain("![200, 204].includes(res.status)");
    expect(readFileSync(path.join(result.sandbox!, "src", "deploy.ts"), "utf8")).toBe(result.changes[0]!.after);
    // the original repo is untouched
    expect(readFileSync(path.join(dir, callSite.file), "utf8")).toBe(original);
    expect(existsSync(path.join(dir, "test", "shapi"))).toBe(false);
  }, 60_000);

  it("falls back to the LLM fixer when no recipe applies, and keeps its change only because the test passes", async () => {
    const { dir, callSite, original } = demoRepo("llm");
    const requests: FixRequest[] = [];
    const llm: LlmFixer = {
      async fix(req) {
        requests.push(req);
        return { status: "proposed", files: [{ path: req.file.path, content: fixedText(req.file.content) }], explanation: "accept 200 and 204", model: "stub" };
      },
    };
    const result = await repair(dir, callSite, { llm, noRecipe: true });
    expect(result.status).toBe("fixed");
    expect(result.method).toBe("llm");
    expect(result.attempts.map((a) => `${a.method}:${a.outcome}`)).toEqual(["recipe:skipped", "llm:passed"]);
    expect(requests[0]!.failingOutput).toContain("deploy dispatch failed with 200");
    expect(requests[0]!.test.content).toContain("SHAPI contract");
    expect(result.changes[0]).toMatchObject({ file: "src/deploy.ts", before: original, notes: ["accept 200 and 204"] });
  }, 60_000);

  it("rejects an LLM change that does not make the test pass, and restores the file", async () => {
    const { dir, callSite, original } = demoRepo("llm-bad");
    const llm: LlmFixer = {
      async fix(req) {
        return { status: "proposed", files: [{ path: req.file.path, content: `${req.file.content}\n// looks fixed\n` }], explanation: "no-op", model: "stub" };
      },
    };
    const result = await repair(dir, callSite, { llm, noRecipe: true });
    expect(result.status).toBe("rejected");
    expect(result.changes).toEqual([]);
    expect(result.attempts.at(-1)).toMatchObject({ method: "llm", outcome: "failed" });
    expect(readFileSync(path.join(result.sandbox!, callSite.file), "utf8")).toBe(original);
  }, 60_000);

  it("refuses LLM writes outside the repo or to the contract test", async () => {
    const { dir, callSite } = demoRepo("llm-escape");
    for (const target of ["../outside.ts", "test/shapi/github-workflow-dispatch-204-to-200.test.ts"]) {
      const llm: LlmFixer = {
        async fix() {
          return { status: "proposed", files: [{ path: target, content: "export {};" }], explanation: "x", model: "stub" };
        },
      };
      const result = await repair(dir, callSite, { llm, noRecipe: true });
      expect(result.status).toBe("rejected");
      expect(result.attempts.at(-1)?.detail).toContain("refused to write");
    }
    expect(existsSync(path.join(tmp, "outside.ts"))).toBe(false);
  }, 60_000);

  it("reports call sites that already handle the new response", async () => {
    const { dir, callSite, original } = demoRepo("handled");
    const fixed = runRecipe(RECIPES, advisory, callSite, original);
    if (fixed.status !== "applied") throw new Error(fixed.status);
    writeFileSync(path.join(dir, callSite.file), fixed.change.after);
    const result = await repair(dir, callSite);
    expect(result.status).toBe("already-handled");
    expect(result.attempts).toEqual([]);
  }, 60_000);

  it("rejects without an LLM when there is no recipe", async () => {
    const { dir, callSite } = demoRepo("no-llm");
    const result = await repair(dir, callSite, { noRecipe: true });
    expect(result.status).toBe("rejected");
    expect(result.attempts.map((a) => a.detail)).toEqual(["advisory names no recipe", "no LLM fixer configured"]);
  }, 60_000);
});

describe("claudeFixer", () => {
  const request: FixRequest = {
    advisory,
    callSite: { id: "abc123abc123", file: "src/deploy.ts", line: 13, column: 21, provider: "github", kind: "http", client: "fetch", method: "POST", host: "api.github.com", endpoint: "/x", resolved: true, surface: { fields: [], statusCodes: [204], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] } },
    file: { path: "src/deploy.ts", content: "export const x = 1;" },
    test: { path: "test/shapi/t.test.ts", content: "test" },
    failingOutput: "deploy dispatch failed with 200",
  };
  /** A stand-in for the SDK client that records the request and returns a canned message. */
  const fakeClient = (message: Partial<Anthropic.Beta.BetaMessage>) => {
    const calls: Anthropic.Beta.MessageCreateParams[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: Anthropic.Beta.MessageCreateParams) => {
            calls.push(params);
            return { model: "claude-fable-5-1", stop_reason: "tool_use", stop_details: null, content: [], ...message };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, calls };
  };

  it("sends the advisory, file, test and failure to the configured model with fallbacks on, and returns the submitted files", async () => {
    const { client, calls } = fakeClient({
      content: [{ type: "tool_use", id: "t1", name: "submit_fix", input: { files: [{ path: "src/deploy.ts", content: "fixed" }], explanation: "accept both" } } as Anthropic.Beta.BetaToolUseBlock],
    });
    const proposal = await claudeFixer({ client }).fix(request);
    expect(proposal).toEqual({ status: "proposed", files: [{ path: "src/deploy.ts", content: "fixed" }], explanation: "accept both", model: "claude-fable-5-1" });
    const params = calls[0]!;
    expect(params).toMatchObject({ model: "claude-fable-5-1", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], tool_choice: { type: "auto" } });
    expect(params).not.toHaveProperty("thinking");
    const content = params.messages[0]!.content as string;
    expect(content).toContain("github-workflow-dispatch-204-to-200");
    expect(content).toContain("deploy dispatch failed with 200");
  });

  it("declines on refusal, on a text-only answer, and on input that breaks the schema", async () => {
    const refused = fakeClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as Anthropic.Beta.BetaMessage["stop_details"] });
    expect(await claudeFixer({ client: refused.client }).fix(request)).toEqual({ status: "declined", reason: "model declined (cyber)" });
    const text = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "No safe change exists.", citations: null } as Anthropic.Beta.BetaTextBlock] });
    expect(await claudeFixer({ client: text.client }).fix(request)).toEqual({ status: "declined", reason: "No safe change exists." });
    const bad = fakeClient({ content: [{ type: "tool_use", id: "t1", name: "submit_fix", input: { files: [] } } as unknown as Anthropic.Beta.BetaToolUseBlock] });
    expect(await claudeFixer({ client: bad.client }).fix(request)).toMatchObject({ status: "declined" });
  });
});
