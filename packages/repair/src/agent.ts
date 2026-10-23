import path from "node:path";
import type { Advisory, LockedCallSite } from "@shapi/core";
import type { ResponseShape } from "@shapi/shapes";
import { generateContractTest } from "./contract";
import type { LlmFixer } from "./llm";
import { runRecipe, type FileChange, type Recipe } from "./recipe";
import { runFailure, testsRan, type TestRun } from "./runner";
import { localWorkspace, type Workspace } from "./workspace";

export interface RepairInput {
  /**
   * Where to work: a sandbox workspace (the hosted service), or else a temp copy of `repoDir`
   * (the CLI on the developer's own checkout). The original repository is never modified.
   */
  workspace?: Workspace;
  repoDir?: string;
  advisory: Advisory;
  callSite: LockedCallSite;
  /** The response the code was written against, and the one the provider sends now (not needed with an advisory `fix`). */
  before?: ResponseShape;
  after?: ResponseShape;
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
  /** Where the fixed code was verified: a local folder, or "<provider>:<sandbox id>". */
  sandbox?: string;
  /** Source files changed by the fix, plus the added contract test. Paths are repo-relative. */
  changes: FileChange[];
  test?: { file: string; content: string };
  /** The contract test run before any change: it must fail for a fix to be attempted. */
  baseline?: TestRun;
  attempts: Attempt[];
  reason?: string;
}

const PROTECTED = new Set([".git", "node_modules", "dist", "coverage", ".shapi"]);

/**
 * Repair one affected call site, test-first:
 * 1. work in a copy of the repo, 2. write the generated contract test and confirm it fails,
 * 3. apply the advisory's recipe, or ask the LLM fixer, 4. keep the change only if the test passes.
 */
export async function repairCallSite(input: RepairInput): Promise<RepairResult> {
  const { advisory, callSite } = input;
  if (!input.workspace && !input.repoDir) throw new Error("repairCallSite needs a workspace or a repoDir");
  const ws = input.workspace ?? localWorkspace(input.repoDir!);
  const original = await ws.read(callSite.file);
  if (original === undefined) return { status: "unsupported", sandbox: ws.location, changes: [], attempts: [], reason: `${callSite.file} is not in the repository` };
  const test = generateContractTest({ callSite, advisory, before: input.before, after: input.after, sourceText: original });
  if (test.status !== "generated") return { status: "unsupported", changes: [], attempts: [], reason: test.reason };

  await ws.write(test.file, test.content);
  const testChange: FileChange = { file: test.file, before: "", after: test.content, notes: ["generated contract test"] };

  const baseline = await ws.runTest(test.file);
  // The baseline only confirms the breakage if the test really ran and failed; a broken environment proves nothing.
  if (!baseline.passed && !testsRan(baseline.output)) {
    return {
      status: "unsupported",
      sandbox: ws.location,
      changes: [],
      test: { file: test.file, content: test.content },
      baseline,
      attempts: [],
      reason: `the contract test could not run: ${runFailure(baseline.output)}`,
    };
  }
  if (baseline.passed) {
    return {
      status: "already-handled",
      sandbox: ws.location,
      changes: [],
      test: { file: test.file, content: test.content },
      baseline,
      attempts: [],
      reason: "the contract test already passes against the new response",
    };
  }

  const attempts: Attempt[] = [];
  const recipe = runRecipe(input.recipes, advisory, callSite, original);
  if (recipe.status === "applied") {
    await ws.write(callSite.file, recipe.change.after);
    const run = await ws.runTest(test.file);
    attempts.push({ method: "recipe", outcome: run.passed ? "passed" : "failed", detail: recipe.recipe, run });
    if (run.passed) {
      return { status: "fixed", method: "recipe", sandbox: ws.location, changes: [recipe.change, testChange], test: { file: test.file, content: test.content }, baseline, attempts };
    }
    await ws.write(callSite.file, original);
  } else {
    attempts.push({ method: "recipe", outcome: "skipped", detail: recipe.reason });
  }

  if (!input.llm) {
    attempts.push({ method: "llm", outcome: "skipped", detail: "no LLM fixer configured" });
    return rejected(ws, test, baseline, attempts);
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
    return rejected(ws, test, baseline, attempts);
  }

  const changes: FileChange[] = [];
  for (const f of proposal.files) {
    const rel = path.posix.normalize(f.path.replaceAll("\\", "/"));
    if (rel.startsWith("..") || path.posix.isAbsolute(rel) || rel === test.file || rel.split("/").some((s) => PROTECTED.has(s))) {
      attempts.push({ method: "llm", outcome: "failed", detail: `refused to write ${f.path}: outside the repo, the test, or a protected folder` });
      await restore(ws, changes);
      return rejected(ws, test, baseline, attempts);
    }
    const before = (await ws.read(rel)) ?? "";
    await ws.write(rel, f.content);
    changes.push({ file: rel, before, after: f.content, notes: [proposal.explanation] });
  }
  const run = await ws.runTest(test.file);
  attempts.push({ method: "llm", outcome: run.passed ? "passed" : "failed", detail: `${proposal.model}: ${proposal.explanation}`, run });
  if (run.passed) {
    return { status: "fixed", method: "llm", sandbox: ws.location, changes: [...changes, testChange], test: { file: test.file, content: test.content }, baseline, attempts };
  }
  await restore(ws, changes);
  return rejected(ws, test, baseline, attempts);
}

function rejected(ws: Workspace, test: { file: string; content: string }, baseline: TestRun, attempts: Attempt[]): RepairResult {
  return {
    status: "rejected",
    sandbox: ws.location,
    changes: [],
    test: { file: test.file, content: test.content },
    baseline,
    attempts,
    reason: "no change made the contract test pass",
  };
}

/** Put LLM-written files back to their content before the attempt. */
async function restore(ws: Workspace, changes: FileChange[]): Promise<void> {
  for (const c of changes) await ws.write(c.file, c.before);
}
