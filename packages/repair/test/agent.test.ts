import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore } from "@shapi/shapes";
import { loadRecording, replay } from "@shapi/canary";
import {
  MAX_LLM_FILE_BYTES,
  RECIPES,
  claudeFixer,
  localWorkspace,
  repairAdvisory,
  repairCallSite,
  runFailure,
  runRecipe,
  runTestFile,
  testsRan,
  withCallBudget,
  type FixRequest,
  type LlmFixer,
  type SuiteRun,
  type TestRun,
  type Workspace,
} from "@shapi/repair";

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

/** Repaired in a workspace the test keeps, so it can look at what was left there. */
async function repair(dir: string, callSite: ReturnType<typeof demoRepo>["callSite"], opts: { llm?: LlmFixer; noRecipe?: boolean } = {}) {
  const workspace = localWorkspace(dir);
  sandboxes.push(workspace.location);
  const result = await repairCallSite({
    workspace,
    advisory: opts.noRecipe ? { ...advisory, recipeId: undefined } : advisory,
    callSite,
    ...shapes,
    recipes: RECIPES,
    llm: opts.llm,
  });
  return result;
}

const fixedText = (original: string) => original.replace("res.status !== 204", "res.status !== 200 && res.status !== 204");

describe("repairCallSite", () => {
  it("with only a repoDir, removes its temp copy (which can hold .env files) when it returns", async () => {
    const { dir, callSite } = demoRepo("temp-copy");
    const site = await repairCallSite({ repoDir: dir, advisory, callSite, ...shapes, recipes: RECIPES });
    expect(site.status).toBe("fixed");
    expect(existsSync(site.sandbox!)).toBe(false);
    const all = await repairAdvisory({ repoDir: dir, advisory, callSites: [callSite], ...shapes, recipes: RECIPES });
    expect(all.status).toBe("fixed");
    expect(existsSync(all.sandbox!)).toBe(false);
  }, 60_000);

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

  it("never takes a test run that crashed before running tests as proof of the breakage", async () => {
    const { dir, callSite, original } = demoRepo("broken-env");
    // Exactly what vitest printed in E2B's Node 20.9 image: a startup crash, no tests run.
    const startupCrash = [
      "⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯",
      "file:///home/user/repo/node_modules/rolldown/dist/shared/create-bundler-option.mjs:8",
      "SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'",
    ].join("\n");
    const files = new Map([[callSite.file, original]]);
    const runs: string[] = [];
    const ws: Workspace = {
      location: "fake:1",
      read: async (f) => files.get(f),
      write: async (f, c) => void files.set(f, c),
      remove: async (f) => void files.delete(f),
      runTest: async (f) => (runs.push(f), { passed: false, exitCode: 1, output: startupCrash }),
    };
    const result = await repairCallSite({ workspace: ws, advisory, callSite, ...shapes, recipes: RECIPES });
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("the contract test could not run: SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'");
    expect(runs).toHaveLength(1);
    expect(files.get(callSite.file)).toBe(original);
    void dir;
  });

  it("recognises a vitest run that actually ran tests", () => {
    expect(testsRan(" Test Files  1 failed (1)\n      Tests  1 failed (1)")).toBe(true);
    expect(testsRan("      Tests  2 passed (2)")).toBe(true);
    expect(testsRan(" Test Files  1 failed (1)\n      Tests  no tests")).toBe(false);
    expect(testsRan("Startup Error")).toBe(false);
    expect(runFailure(" RUN  v5.0.5 /tmp/shapi-repair-x\n\nNo test files found, exiting with code 1")).toBe("No test files found, exiting with code 1");
  });

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

/** vitest's output for a contract test that failed the way the advisory says, and for one that passed. */
const BROKEN: TestRun = {
  passed: false,
  exitCode: 1,
  output: " FAIL  test/shapi/x.test.ts > triggerDeploy\nError: SHAPI breakage: triggerDeploy() fails on the response github sends now: deploy dispatch failed with 200\n      Tests  1 failed | 1 passed (2)",
};
const PASSED: TestRun = { passed: true, exitCode: 0, output: "      Tests  2 passed (2)" };

/** A workspace in memory: `run` answers each test run (numbered from 0, the baseline). */
function memoryWorkspace(seed: Record<string, string>, run: (n: number, files: Map<string, string>, file: string) => TestRun) {
  const files = new Map(Object.entries(seed));
  const written: string[] = [];
  let n = 0;
  const ws: Workspace = {
    location: "memory:1",
    read: async (f) => files.get(f),
    write: async (f, c) => {
      if (f === "src/folder.ts") throw new Error("EISDIR: illegal operation on a directory, open 'src/folder.ts'");
      written.push(f);
      files.set(f, c);
    },
    remove: async (f) => void files.delete(f),
    runTest: async (f) => run(n++, files, f),
  };
  return { ws, files, written };
}

const proposing = (files: { path: string; content: string }[]): LlmFixer => ({ fix: async () => ({ status: "proposed", files, explanation: "x", model: "stub" }) });

describe("repairCallSite: what an LLM change has to get past", () => {
  const { callSite, original } = demoRepo("llm-guards");
  const testFile = "test/shapi/github-workflow-dispatch-204-to-200.test.ts";
  const attempt = (llm: LlmFixer, run: (n: number) => TestRun = (n) => (n === 0 ? BROKEN : PASSED)) => {
    const mem = memoryWorkspace({ [callSite.file]: original }, run);
    return { mem, result: repairCallSite({ workspace: mem.ws, advisory: { ...advisory, recipeId: undefined }, callSite, ...shapes, recipes: RECIPES, llm }) };
  };

  it("only writes source files: never config, manifests, CI, setup files or any contract test, in any letter case", async () => {
    for (const target of [
      "vitest.config.ts",
      "package.json",
      "tsconfig.json",
      ".github/workflows/ci.yml",
      "test/setup.ts",
      "src/__mocks__/deploy.ts",
      "src/types.d.ts",
      "TEST/Shapi/github-workflow-dispatch-204-to-200.test.ts",
      "test/shapi/github-workflow-dispatch-204-to-200.2.test.ts",
      "C:/Users/someone/evil.ts",
      "src/deploy.test.ts",
      "src/deploy.spec.js",
      "test/billing.ts",
      "src/__tests__/deploy.ts",
      "e2e/deploy.mjs",
      "src",
    ]) {
      const { mem, result } = attempt(proposing([{ path: target, content: "export {};" }]));
      const r = await result;
      expect(r.status, target).toBe("rejected");
      expect(r.attempts.at(-1)?.detail, target).toContain(`refused to write ${target}`);
      expect(mem.written, target).toEqual([testFile]);
    }
  });

  it("does not count a run that ran no test as passing", async () => {
    const noTests: TestRun = { passed: true, exitCode: 0, output: "No test files found, exiting with code 0" };
    const r = await attempt(proposing([{ path: callSite.file, content: fixedText(original) }]), (n) => (n === 0 ? BROKEN : noTests)).result;
    expect(r.status).toBe("rejected");
    expect(r.attempts.at(-1)).toMatchObject({ method: "llm", outcome: "failed" });
  });

  it("rejects a 'fix' that deletes the call or its status check, even though the test passes (V-06)", async () => {
    const dispatch = "POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches";
    // The whole function body goes: nothing calls GitHub any more.
    const noCall = original.replace(/const res = await fetch\(`\$\{GITHUB_API\}\/repos[\s\S]*?\n {2}\}\n(?=\}\n\nexport async function latest)/, "void req;\n  void token;\n");
    expect(noCall).not.toContain("/dispatches");
    const deleted = await attempt(proposing([{ path: callSite.file, content: noCall }])).result;
    expect(deleted.status).toBe("rejected");
    expect(deleted.attempts.at(-1)?.detail).toBe(`stub: x; the test passes, but the change removes the call to ${dispatch}`);
    // The call stays, but the status check that the change is about is gone.
    const unchecked = original.replace(/ {2}if \(res\.status !== 204\) \{\n.*\n {2}\}\n/, "");
    expect(unchecked).not.toContain("res.status !== 204");
    const r = await attempt(proposing([{ path: callSite.file, content: unchecked }])).result;
    expect(r.status).toBe("rejected");
    expect(r.attempts.at(-1)?.detail).toBe(`stub: x; the test passes, but the change stops checking the status at ${dispatch}`);
    // A real fix keeps both.
    const fixed = await attempt(proposing([{ path: callSite.file, content: fixedText(original) }])).result;
    expect(fixed).toMatchObject({ status: "fixed", keep: { status: "kept" } });
  });

  it("undoes a rejected change exactly: a path given twice, and a file it created", async () => {
    const { mem, result } = attempt(
      proposing([
        { path: callSite.file, content: "A" },
        { path: callSite.file, content: "B" },
        { path: "src/new.ts", content: "N" },
      ]),
      () => BROKEN,
    );
    expect((await result).status).toBe("rejected");
    expect(mem.files.get(callSite.file)).toBe(original);
    expect(mem.files.has("src/new.ts")).toBe(false);
    // only the last content given for a path is tried: one write, then the restore
    expect(mem.written.filter((f) => f === callSite.file)).toHaveLength(2);
  });

  it("turns a failing write or a throwing fixer into a rejected attempt instead of failing the job", async () => {
    const write = attempt(proposing([{ path: callSite.file, content: fixedText(original) }, { path: "src/folder.ts", content: "x" }]));
    const w = await write.result;
    expect(w.status).toBe("rejected");
    expect(w.attempts.at(-1)?.detail).toBe("the LLM attempt failed: EISDIR: illegal operation on a directory, open 'src/folder.ts'");
    expect(write.mem.files.get(callSite.file)).toBe(original);
    const throwing = attempt({ fix: async () => Promise.reject(new TypeError("socket hang up")) });
    const r = await throwing.result;
    expect(r.status).toBe("rejected");
    expect(r.attempts.at(-1)).toMatchObject({ method: "llm", outcome: "failed", detail: "the LLM attempt failed: socket hang up" });
  });

  it("does not try a fix when the baseline failed for another reason than the API change", async () => {
    const asked: FixRequest[] = [];
    const other: TestRun = { passed: false, exitCode: 1, output: " FAIL  test/shapi/x.test.ts\nTypeError: Cannot read properties of undefined (reading 'owner')\n      Tests  2 failed (2)" };
    const mem = memoryWorkspace({ [callSite.file]: original }, () => other);
    const llm: LlmFixer = { fix: async (req) => (asked.push(req), { status: "declined", reason: "x" }) };
    const r = await repairCallSite({ workspace: mem.ws, advisory, callSite, ...shapes, recipes: RECIPES, llm });
    expect(r.status).toBe("unsupported");
    expect(r.reason).toBe("the contract test fails before it reaches the API change: TypeError: Cannot read properties of undefined (reading 'owner')");
    expect(asked).toEqual([]);
    expect(mem.files.get(callSite.file)).toBe(original);
  });
});

/** A one-file TypeScript repo linking the monorepo's node_modules (TypeScript, vitest, @types/node), with a strict tsconfig unless told otherwise. */
function tsRepo(name: string, source: string, opts: { tsconfig?: boolean } = {}) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module" }));
  if (opts.tsconfig !== false) {
    const compilerOptions = { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022", "dom"], types: ["node"], noEmit: true };
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src"] }));
  }
  writeFileSync(path.join(dir, "src", "app.ts"), source);
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "junction");
  const sites = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory], { now: new Date("2026-10-23") }).affected.map((f) => f.callSite);
  return { dir, callSite: sites[0]!, sites };
}

const DISPATCH = `export async function deploy(owner: string, repo: string, workflow: string): Promise<void> {
  const res = await fetch(\`https://api.github.com/repos/\${owner}/\${repo}/actions/workflows/\${workflow}/dispatches\`, { method: "POST" });
  if (res.status !== 204) throw new Error(\`deploy dispatch failed with \${res.status}\`);
}
`;

describe("repairCallSite: the fix must type-check", () => {
  it("type-checks a recipe fix with the repo's tsconfig", async () => {
    const { dir, callSite } = tsRepo("tsc-recipe", DISPATCH);
    const result = await repair(dir, callSite);
    expect(result.status).toBe("fixed");
    expect(result.typecheck).toEqual({ status: "passed", detail: "tsc --noEmit -p tsconfig.json: no new errors" });
  }, 120_000);

  it("rejects a change that passes the test but adds a type error", async () => {
    const { dir, callSite } = tsRepo("tsc-llm", DISPATCH);
    const llm = proposing([{ path: callSite.file, content: `${fixedText(DISPATCH)}export const port: number = "8080";\n` }]);
    const result = await repair(dir, callSite, { llm, noRecipe: true });
    expect(result.status).toBe("rejected");
    const last = result.attempts.at(-1)!;
    expect(last).toMatchObject({ method: "llm", outcome: "failed" });
    expect(last.run?.passed).toBe(true);
    expect(last.detail).toContain("the test passes, but tsc --noEmit -p tsconfig.json: 1 new error: src/app.ts: TS2322 Type 'string' is not assignable to type 'number'.");
  }, 120_000);

  it("says so when it could not type-check, without blocking the fix", async () => {
    const { dir, callSite } = tsRepo("tsc-none", DISPATCH, { tsconfig: false });
    const result = await repair(dir, callSite);
    expect(result.status).toBe("fixed");
    expect(result.typecheck).toEqual({ status: "skipped", detail: "not type-checked: no tsconfig.json above src/app.ts" });
  }, 120_000);
});

const BREAKAGE_LINE = "SHAPI breakage: deploy() fails on the response github sends now: deploy dispatch failed with 200";

describe("repairCallSite: contract tests that prove the right thing", () => {
  it("imports a default export as the default", async () => {
    const { dir, callSite } = tsRepo("default-export", DISPATCH.replace("export async function deploy", "export default async function deploy"), { tsconfig: false });
    const result = await repair(dir, callSite);
    expect(result.test?.content).toContain('import deploy from "../../src/app";');
    expect(result.status).toBe("fixed");
  }, 120_000);

  it("does not take a crash on the generated arguments for the API change", async () => {
    const source = DISPATCH.replace("owner: string, repo: string, workflow: string", "target: Target").replace("${owner}/${repo}/actions/workflows/${workflow}", "${target.owner.trim()}/x/actions/workflows/y");
    const { dir, callSite } = tsRepo("args-crash", `import type { Target } from "./types";\n${source}`, { tsconfig: false });
    const result = await repair(dir, callSite, { llm: proposing([]) });
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/^the contract test fails before it reaches the API change: TypeError: Cannot read properties of undefined/);
    expect(result.attempts).toEqual([]);
  }, 120_000);

  it("runs the contract test in a repo whose vitest config only includes its own tests", async () => {
    const { dir, callSite } = tsRepo("vitest-include", DISPATCH, { tsconfig: false });
    writeFileSync(path.join(dir, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["src/**/*.test.ts"], exclude: ["test/**"] } });\n`);
    const result = await repair(dir, callSite);
    expect(result.baseline?.output).toContain(BREAKAGE_LINE);
    expect(result.status).toBe("fixed");
  }, 120_000);
});

describe("repairAdvisory: the combined change", () => {
  it("runs every fixed site's test again on the combined change, and does not report a site whose fix a later one undid", async () => {
    const two = `${DISPATCH}\n${DISPATCH.replace("function deploy", "function redeploy")}`;
    const { sites } = tsRepo("combined", two, { tsconfig: false });
    expect(sites.map((s) => s.line)).toEqual([2, 7]);
    const accept = (line: string) => line.replace("res.status !== 204", "res.status !== 200 && res.status !== 204");
    // Each proposal accepts 200 on its own site's check line and puts every other check line back as it was.
    const llm: LlmFixer = {
      async fix(req) {
        const own = req.callSite.line + 1;
        const content = two.split("\n").map((l, i) => (i + 1 === own ? accept(l) : l)).join("\n");
        return { status: "proposed", files: [{ path: req.file.path, content }], explanation: `site ${req.callSite.line}`, model: "stub" };
      },
    };
    // A test passes when its own site's check line accepts 200.
    const siteOf = new Map([
      ["test/shapi/github-workflow-dispatch-204-to-200.test.ts", 7],
      ["test/shapi/github-workflow-dispatch-204-to-200.2.test.ts", 2],
    ]);
    const mem = memoryWorkspace({ "src/app.ts": two }, (_n, files, file) => (files.get("src/app.ts")!.split("\n")[siteOf.get(file)!]!.includes("!== 200") ? PASSED : BROKEN));
    const result = await repairAdvisory({ workspace: mem.ws, advisory: { ...advisory, recipeId: undefined }, callSites: sites, ...shapes, recipes: RECIPES, llm });
    expect(result.sites.map((s) => [s.callSite.line, s.result.status])).toEqual([
      [7, "rejected"],
      [2, "fixed"],
    ]);
    expect(result.sites[0]!.result.reason).toBe("its contract test fails on the combined change of all the call sites");
    expect(result.status).toBe("partial");
    expect(result.changes.map((c) => c.file)).toEqual(["src/app.ts", "test/shapi/github-workflow-dispatch-204-to-200.2.test.ts"]);
  });
});

describe("local workspace", () => {
  it("is deleted by dispose(), leaving the checkout and its node_modules alone", async () => {
    const dir = path.join(tmp, "dispose");
    for (const d of ["node_modules/dep", "packages/a/node_modules/inner", "packages/a/dist", "dist"]) mkdirSync(path.join(dir, d), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "");
    writeFileSync(path.join(dir, "packages", "a", "node_modules", "inner", "index.js"), "");
    writeFileSync(path.join(dir, "packages", "a", "dist", "index.js"), "built");
    writeFileSync(path.join(dir, "dist", "out.js"), "");
    writeFileSync(path.join(dir, ".env"), "SECRET=1");
    const ws = localWorkspace(dir);
    // a package's committed dist/ is code the call site can import; nested node_modules are linked like the root's
    expect(await ws.read("packages/a/dist/index.js")).toBe("built");
    expect(existsSync(path.join(ws.location, "packages", "a", "node_modules", "inner", "index.js"))).toBe(true);
    expect(existsSync(path.join(ws.location, "dist"))).toBe(false);
    await ws.remove("packages/a/dist/index.js");
    expect(await ws.read("packages/a/dist/index.js")).toBeUndefined();
    await ws.dispose();
    expect(existsSync(ws.location)).toBe(false);
    for (const f of ["node_modules/dep/index.js", "packages/a/node_modules/inner/index.js", "packages/a/dist/index.js", ".env"]) expect(existsSync(path.join(dir, f)), f).toBe(true);
  });

  it("runs the repo's tests without the caller's tokens in the environment", () => {
    const dir = path.join(tmp, "env");
    mkdirSync(path.join(dir, "test"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "test", "env.test.ts"), `import { expect, it } from "vitest";\nit("sees no token", () => expect(process.env.SHAPI_TEST_TOKEN).toBeUndefined());\n`);
    process.env.SHAPI_TEST_TOKEN = "secret";
    try {
      expect(runTestFile(dir, "test/env.test.ts").output).toContain("1 passed");
    } finally {
      delete process.env.SHAPI_TEST_TOKEN;
    }
  }, 60_000);
});

describe("LLM spend", () => {
  it("declines once a job's call budget is used up", async () => {
    let calls = 0;
    const llm = withCallBudget({ fix: async () => (calls++, { status: "declined", reason: "no" }) }, 2);
    const req = {} as FixRequest;
    await llm.fix(req);
    await llm.fix(req);
    expect(await llm.fix(req)).toEqual({ status: "declined", reason: "the 2 LLM calls allowed are used up (SHAPI_LLM_CALLS_PER_JOB)" });
    expect(calls).toBe(2);
  });

  it("shares one budget between runs that count calls in the same place", async () => {
    let calls = 0;
    let stored = 0;
    const fixer = { fix: async () => (calls++, { status: "declined" as const, reason: "no" }) };
    const take = async () => ++stored;
    const req = {} as FixRequest;
    await withCallBudget(fixer, 2, take).fix(req);
    // A retried job: a new budget, the same count.
    const retry = withCallBudget(fixer, 2, take);
    await retry.fix(req);
    expect((await retry.fix(req)).status).toBe("declined");
    expect(calls).toBe(2);
  });

  it("does not send a file larger than the limit", async () => {
    let called = false;
    const client = { beta: { messages: { create: async () => ((called = true), {}) } } } as unknown as Anthropic;
    const big = { path: "src/huge.ts", content: "x".repeat(MAX_LLM_FILE_BYTES + 1) };
    const proposal = await claudeFixer({ client }).fix({ file: big } as FixRequest);
    expect(proposal).toEqual({ status: "declined", reason: "src/huge.ts is too large to send to the model (200 kB, limit 200 kB)" });
    expect(called).toBe(false);
  });
});

describe("repairAdvisory and the repository's own tests (V-01)", () => {
  const pass: SuiteRun = { passed: true, exitCode: 0, output: " Test Files  1 passed (1)\n      Tests  4 passed (4)\n", command: "npm test" };
  const fail: SuiteRun = { passed: false, exitCode: 1, output: " × billing > charges 3ms\n Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)\n", command: "npm test" };

  /** The demo repo in a local workspace whose test command answers `runs` in order; records what the runner saw. */
  function withSuite(name: string, runs: SuiteRun[]) {
    const { dir, callSite } = demoRepo(name);
    const local = localWorkspace(dir);
    sandboxes.push(local.location);
    const seen: { contractTestPresent: boolean }[] = [];
    let i = 0;
    const testFile = `test/shapi/${advisory.id}.test.ts`;
    const ws: Workspace = {
      ...local,
      async runSuite() {
        seen.push({ contractTestPresent: (await local.read(testFile)) !== undefined });
        return runs[Math.min(i++, runs.length - 1)];
      },
    };
    return { ws, callSite, seen, testFile, local };
  }

  it("keeps a fix when the repository's tests pass before and after, with SHAPI's test set aside while they run", async () => {
    const { ws, callSite, seen, testFile, local } = withSuite("suite-pass", [pass, pass]);
    const repair = await repairAdvisory({ workspace: ws, advisory, callSites: [callSite], ...shapes, recipes: RECIPES });
    expect(repair.status).toBe("fixed");
    expect(repair.suite).toMatchObject({ status: "passed", command: "npm test", before: "4 passed", after: "4 passed", runs: 1 });
    expect(seen).toEqual([{ contractTestPresent: false }, { contractTestPresent: false }]);
    expect(await local.read(testFile)).toBeDefined();
  }, 60_000);

  it("rejects every fix when a test that passed before fails after it", async () => {
    const { ws, callSite } = withSuite("suite-fail", [pass, fail]);
    const repair = await repairAdvisory({ workspace: ws, advisory, callSites: [callSite], ...shapes, recipes: RECIPES });
    expect(repair.status).toBe("none");
    expect(repair.changes).toEqual([]);
    expect(repair.suite).toMatchObject({ status: "failed", runs: 3 });
    expect(repair.sites[0]!.result).toMatchObject({ status: "rejected", reason: "the repository's own tests fail after the change: tests that passed before the change fail after it: billing > charges" });
  }, 60_000);

  it("says the tests were not run when the repository has no test command", async () => {
    const { ws, callSite } = withSuite("suite-none", []);
    const repair = await repairAdvisory({ workspace: { ...ws, runSuite: async () => undefined }, advisory, callSites: [callSite], ...shapes, recipes: RECIPES });
    expect(repair.status).toBe("fixed");
    expect(repair.suite).toMatchObject({ status: "not-run", detail: "the repository has no test command (no test script in package.json)" });
  }, 60_000);
});
