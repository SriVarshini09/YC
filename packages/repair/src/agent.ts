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
  /** Where to write the contract test; default test/shapi/<advisory id>.test.ts. */
  testFile?: string;
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
  if (!/\.(c|m)?[jt]sx?$/.test(callSite.file)) {
    return { status: "unsupported", changes: [], attempts: [], reason: `fixes support TypeScript and JavaScript; ${callSite.file} is scanned only` };
  }
  const ws = input.workspace ?? localWorkspace(input.repoDir!);
  const original = await ws.read(callSite.file);
  if (original === undefined) return { status: "unsupported", sandbox: ws.location, changes: [], attempts: [], reason: `${callSite.file} is not in the repository` };
  const test = generateContractTest({ callSite, advisory, before: input.before, after: input.after, sourceText: original, file: input.testFile });
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

export interface AdvisoryRepairInput extends Omit<RepairInput, "callSite" | "testFile"> {
  /** Every affected call site of the advisory in the repository. */
  callSites: LockedCallSite[];
}

export interface SiteRepair {
  callSite: LockedCallSite;
  result: RepairResult;
}

export interface AdvisoryRepair {
  /** "fixed": every call site that needed a change got one; "partial": some did; "none": none did. */
  status: "fixed" | "partial" | "none";
  /** One entry per call site, in the order they were repaired. */
  sites: SiteRepair[];
  /** The combined change of the fixed sites: each source file once (from its original text), then every contract test. */
  changes: FileChange[];
  method?: "recipe" | "llm";
  sandbox?: string;
}

/**
 * Repair every affected call site of one advisory in one workspace, so a single pull request covers
 * them all. Each site is repaired test-first like repairCallSite, on top of the fixes before it.
 * Within a file the sites go bottom-up, so an edit never moves the lines of a site still to come.
 * Each site gets its own contract test: test/shapi/<id>.test.ts, then <id>.2.test.ts, …
 */
export async function repairAdvisory(input: AdvisoryRepairInput): Promise<AdvisoryRepair> {
  if (!input.workspace && !input.repoDir) throw new Error("repairAdvisory needs a workspace or a repoDir");
  const ws = input.workspace ?? localWorkspace(input.repoDir!);
  const seen = new Set<string>();
  const order = input.callSites
    .filter((s) => {
      const key = `${s.file}:${s.line}:${s.column}`;
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .sort((a, b) => a.file.localeCompare(b.file) || b.line - a.line || b.column - a.column);

  const originals = new Map<string, string>();
  const sites: SiteRepair[] = [];
  for (const [i, callSite] of order.entries()) {
    if (!originals.has(callSite.file)) originals.set(callSite.file, (await ws.read(callSite.file)) ?? "");
    const testFile = `test/shapi/${input.advisory.id}${i === 0 ? "" : `.${i + 1}`}.test.ts`;
    const result = await repairCallSite({ ...input, workspace: ws, callSite, testFile });
    for (const c of result.changes) if (c.before && !originals.has(c.file)) originals.set(c.file, c.before);
    sites.push({ callSite, result });
  }

  const fixed = sites.filter((s) => s.result.status === "fixed");
  const needed = sites.filter((s) => s.result.status !== "already-handled");
  const tests = new Set(fixed.map((s) => s.result.test?.file));
  const sourceFiles = [...new Set(fixed.flatMap((s) => s.result.changes.filter((c) => !tests.has(c.file)).map((c) => c.file)))].sort();
  const changes: FileChange[] = [];
  for (const file of sourceFiles) {
    const notes = fixed.flatMap((s) => s.result.changes.filter((c) => c.file === file).flatMap((c) => c.notes));
    changes.push({ file, before: originals.get(file) ?? "", after: (await ws.read(file)) ?? "", notes });
  }
  for (const s of fixed) if (s.result.test) changes.push({ file: s.result.test.file, before: "", after: s.result.test.content, notes: ["generated contract test"] });

  const methods = new Set(fixed.map((s) => s.result.method));
  return {
    status: fixed.length === 0 ? "none" : fixed.length === needed.length ? "fixed" : "partial",
    sites,
    changes,
    ...(fixed.length ? { method: methods.has("llm") ? ("llm" as const) : ("recipe" as const) } : {}),
    sandbox: ws.location,
  };
}
