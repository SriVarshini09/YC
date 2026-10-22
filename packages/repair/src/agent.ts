import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Advisory, LockedCallSite } from "@shapi/core";
import type { ResponseShape } from "@shapi/shapes";
import { generateContractTest } from "./contract";
import type { LlmFixer } from "./llm";
import { runRecipe, type FileChange, type Recipe } from "./recipe";
import { runTestFile, type TestRun } from "./runner";

export interface RepairInput {
  /** The repository to repair. It is never modified: all work happens in a sandbox copy. */
  repoDir: string;
  advisory: Advisory;
  callSite: LockedCallSite;
  /** The response the code was written against, and the one the provider sends now. */
  before: ResponseShape;
  after: ResponseShape;
  recipes: Record<string, Recipe>;
  /** Used when no recipe applies, or the recipe's change does not make the test pass. */
  llm?: LlmFixer;
}

export interface Attempt {
  method: "recipe" | "llm";
  outcome: "passed" | "failed" | "skipped";
  detail: string;
  run?: TestRun;
}

export interface RepairResult {
  status: "fixed" | "rejected" | "already-handled" | "unsupported";
  method?: "recipe" | "llm";
  /** Sandbox copy holding the fixed code (for inspection or delivery). */
  sandbox?: string;
  /** Source files changed by the fix, plus the added contract test. Paths are repo-relative. */
  changes: FileChange[];
  test?: { file: string; content: string };
  /** The contract test run before any change: it must fail for a fix to be attempted. */
  baseline?: TestRun;
  attempts: Attempt[];
  reason?: string;
}

const COPY_SKIP = new Set([".git", "node_modules", "dist", "coverage", ".shapi"]);

/**
 * Repair one affected call site, test-first:
 * 1. copy the repo into a sandbox, 2. write the generated contract test and confirm it fails,
 * 3. apply the advisory's recipe, or ask the LLM fixer, 4. keep the change only if the test passes.
 */
export async function repairCallSite(input: RepairInput): Promise<RepairResult> {
  const { repoDir, advisory, callSite } = input;
  const original = readFileSync(path.join(repoDir, callSite.file), "utf8");
  const test = generateContractTest({ callSite, advisory, before: input.before, after: input.after, sourceText: original });
  if (test.status !== "generated") return { status: "unsupported", changes: [], attempts: [], reason: test.reason };

  const sandbox = makeSandbox(repoDir);
  const testPath = path.join(sandbox, test.file);
  mkdirSync(path.dirname(testPath), { recursive: true });
  writeFileSync(testPath, test.content);
  const testChange: FileChange = { file: test.file, before: "", after: test.content, notes: ["generated contract test"] };

  const baseline = runTestFile(sandbox, test.file);
  if (baseline.passed) {
    return {
      status: "already-handled",
      sandbox,
      changes: [],
      test: { file: test.file, content: test.content },
      baseline,
      attempts: [],
      reason: "the contract test already passes against the new response",
    };
  }

  const attempts: Attempt[] = [];
  const target = path.join(sandbox, callSite.file);

  const recipe = runRecipe(input.recipes, advisory, callSite, original);
  if (recipe.status === "applied") {
    writeFileSync(target, recipe.change.after);
    const run = runTestFile(sandbox, test.file);
    attempts.push({ method: "recipe", outcome: run.passed ? "passed" : "failed", detail: recipe.recipe, run });
    if (run.passed) {
      return { status: "fixed", method: "recipe", sandbox, changes: [recipe.change, testChange], test: { file: test.file, content: test.content }, baseline, attempts };
    }
    writeFileSync(target, original);
  } else {
    attempts.push({ method: "recipe", outcome: "skipped", detail: recipe.reason });
  }

  if (!input.llm) {
    attempts.push({ method: "llm", outcome: "skipped", detail: "no LLM fixer configured" });
    return rejected(sandbox, test, baseline, attempts);
  }

  const proposal = await input.llm.fix({
    advisory,
    callSite,
    file: { path: callSite.file, content: original },
    test: { path: test.file, content: test.content },
    failingOutput: baseline.output,
  });
  if (proposal.status !== "proposed") {
    attempts.push({ method: "llm", outcome: "skipped", detail: proposal.reason });
    return rejected(sandbox, test, baseline, attempts);
  }

  const changes: FileChange[] = [];
  for (const f of proposal.files) {
    const rel = path.posix.normalize(f.path.replaceAll("\\", "/"));
    if (rel.startsWith("..") || path.posix.isAbsolute(rel) || rel === test.file || rel.split("/").some((s) => COPY_SKIP.has(s))) {
      attempts.push({ method: "llm", outcome: "failed", detail: `refused to write ${f.path}: outside the repo, the test, or a protected folder` });
      restore(sandbox, repoDir, changes);
      return rejected(sandbox, test, baseline, attempts);
    }
    const abs = path.join(sandbox, rel);
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    changes.push({ file: rel, before, after: f.content, notes: [proposal.explanation] });
  }
  const run = runTestFile(sandbox, test.file);
  attempts.push({ method: "llm", outcome: run.passed ? "passed" : "failed", detail: `${proposal.model}: ${proposal.explanation}`, run });
  if (run.passed) {
    return { status: "fixed", method: "llm", sandbox, changes: [...changes, testChange], test: { file: test.file, content: test.content }, baseline, attempts };
  }
  restore(sandbox, repoDir, changes);
  return rejected(sandbox, test, baseline, attempts);
}

function rejected(sandbox: string, test: { file: string; content: string }, baseline: TestRun, attempts: Attempt[]): RepairResult {
  return {
    status: "rejected",
    sandbox,
    changes: [],
    test: { file: test.file, content: test.content },
    baseline,
    attempts,
    reason: "no change made the contract test pass",
  };
}

/** Put LLM-written files back to the repo's version. */
function restore(sandbox: string, repoDir: string, changes: FileChange[]): void {
  for (const c of changes) {
    const src = path.join(repoDir, c.file);
    if (existsSync(src)) writeFileSync(path.join(sandbox, c.file), readFileSync(src));
  }
}

/** Copy the repo (without .git, build output or dependencies) and link its node_modules so its own test setup works. */
function makeSandbox(repoDir: string): string {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "shapi-repair-"));
  cpSync(repoDir, sandbox, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(path.basename(src)) || path.resolve(src) === path.resolve(repoDir),
  });
  const modules = path.join(repoDir, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, path.join(sandbox, "node_modules"), "junction");
  return sandbox;
}
