import path from "node:path";
import type { Advisory, LockedCallSite } from "@shapi/core";
import { SandboxLifetimeError } from "@shapi/sandbox";
import type { ResponseShape } from "@shapi/shapes";
import { BREAKAGE, CONTRACT_DIR, UNTESTABLE, generateContractTest } from "./contract";
import type { LlmFixer } from "./llm";
import { runRecipe, type FileChange, type Recipe } from "./recipe";
import { SHAPI_VITEST_CONFIG, runFailure, testsRan, type TestRun } from "./runner";
import { checkSuite, type SuiteCheck, type SuiteRun } from "./suite";
import { checkKept, type KeepCheck } from "./keep";
import { checkTypes, typeBaseline, type TypeBaseline, type TypeCheck } from "./typecheck";
import { localWorkspace, type Workspace } from "./workspace";

export interface RepairInput {
  /**
   * Where to work: a sandbox workspace (the hosted service), or else a temp copy of `repoDir`
   * (the CLI on the developer's own checkout), removed when the repair returns. The original
   * repository is never modified.
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
  /** The contract test, and what its stub was built from: recorded responses, or the advisory's fix (`request`, `same-result`). */
  test?: { file: string; content: string; kind?: "request" | "same-result" | "recorded" };
  /** The contract test run before any change: it must fail for a fix to be attempted. */
  baseline?: TestRun;
  attempts: Attempt[];
  reason?: string;
  /**
   * For a fix: whether the repository still type-checks (`tsc --noEmit` with its tsconfig, no new
   * errors), or why that was not checked. A fix with new type errors is not kept.
   */
  typecheck?: TypeCheck;
  /** For a fix: whether it keeps the call and the read of what changed (V-06), or why that was not checked. */
  keep?: KeepCheck;
}

const PROTECTED = new Set([".git", "node_modules", "dist", "coverage", ".shapi"]);

/**
 * Repair one affected call site, test-first:
 * 1. work in a copy of the repo, 2. write the generated contract test and confirm it fails the way
 * the advisory says, 3. apply the advisory's recipe, or ask the LLM fixer, 4. keep the change only if
 * the test passes and, in a TypeScript repository, tsc reports no new errors.
 */
export async function repairCallSite(input: RepairInput): Promise<RepairResult> {
  const { advisory, callSite } = input;
  if (!input.workspace && !input.repoDir) throw new Error("repairCallSite needs a workspace or a repoDir");
  if (!/\.(c|m)?[jt]sx?$/.test(callSite.file)) {
    return { status: "unsupported", changes: [], attempts: [], reason: `fixes support TypeScript and JavaScript; ${callSite.file} is scanned only` };
  }
  if (!input.workspace) return inTempCopy(input.repoDir!, (workspace) => repairCallSite({ ...input, workspace }));
  const ws = input.workspace;
  const original = await ws.read(callSite.file);
  if (original === undefined) return { status: "unsupported", sandbox: ws.location, changes: [], attempts: [], reason: `${callSite.file} is not in the repository` };
  const test = generateContractTest({ callSite, advisory, before: input.before, after: input.after, sourceText: original, file: input.testFile });
  if (test.status !== "generated") return { status: "unsupported", changes: [], attempts: [], reason: test.reason };

  await ws.write(test.file, test.content);
  const testChange: FileChange = { file: test.file, before: "", after: test.content, notes: ["generated contract test"] };
  const ran = { file: test.file, content: test.content, kind: test.kind };

  const baseline = await ws.runTest(test.file);
  // The baseline only confirms the breakage if the test really ran and failed; a broken environment proves nothing.
  if (!baseline.passed && !testsRan(baseline.output)) {
    return { status: "unsupported", sandbox: ws.location, changes: [], test: ran, baseline, attempts: [], reason: `the contract test could not run: ${runFailure(baseline.output)}` };
  }
  if (baseline.passed) {
    return {
      status: "already-handled",
      sandbox: ws.location,
      changes: [],
      test: ran,
      baseline,
      attempts: [],
      reason:
        test.kind === "recorded"
          ? "the code handles the new response without an error (the contract test checks that it runs, not what it returns)"
          : "the contract test already passes against the new response",
    };
  }
  // ...and only if it failed the way the advisory says: not on the generated arguments, an import or a missing setting.
  const untestable = marked(baseline.output, UNTESTABLE);
  if (untestable !== undefined || marked(baseline.output, BREAKAGE) === undefined) {
    return {
      status: "unsupported",
      sandbox: ws.location,
      changes: [],
      test: ran,
      baseline,
      attempts: [],
      reason: untestable ?? `the contract test fails before it reaches the API change: ${runFailure(baseline.output)}`,
    };
  }

  const attempts: Attempt[] = [];
  let types: TypeBaseline | undefined;
  /** Run the test on a change and type-check it; the type baseline is taken before the first change is written. */
  const verify = async (write: () => Promise<void>): Promise<{ run: TestRun; typecheck?: TypeCheck }> => {
    types ??= await typeBaseline(ws, callSite.file);
    await write();
    const run = await ws.runTest(test.file);
    // A passing run must have run the test: "no test files found" exits 0 too.
    if (!run.passed || !testsRan(run.output)) return { run: { ...run, passed: false } };
    return { run, typecheck: await checkTypes(ws, types) };
  };
  const failure = (typecheck: TypeCheck | undefined, keep: KeepCheck | undefined, detail: string) =>
    typecheck?.status === "failed" ? `${detail}; the test passes, but ${typecheck.detail}` : keep?.status === "removed" ? `${detail}; the test passes, but ${keep.detail}` : detail;
  /** V-06: a passing change must keep the call and the read of what changed. */
  const keepCheck = async (files: { file: string; before: string; after: string }[]) => checkKept({ advisory, callSite, files, packageJson: await ws.read("package.json") });

  const recipe = runRecipe(input.recipes, advisory, callSite, original);
  if (recipe.status === "applied") {
    const { run, typecheck } = await verify(() => ws.write(callSite.file, recipe.change.after));
    const keep = run.passed && typecheck?.status !== "failed" ? await keepCheck([{ file: callSite.file, before: original, after: recipe.change.after }]) : undefined;
    const kept = run.passed && typecheck?.status !== "failed" && keep?.status !== "removed";
    attempts.push({ method: "recipe", outcome: kept ? "passed" : "failed", detail: kept ? recipe.recipe : failure(typecheck, keep, recipe.recipe), run });
    if (kept) return { status: "fixed", method: "recipe", sandbox: ws.location, changes: [recipe.change, testChange], test: ran, baseline, attempts, typecheck, keep };
    await ws.write(callSite.file, original);
  } else {
    attempts.push({ method: "recipe", outcome: "skipped", detail: recipe.reason });
  }

  if (!input.llm) {
    attempts.push({ method: "llm", outcome: "skipped", detail: "no LLM fixer configured" });
    return rejected(ws, ran, baseline, attempts);
  }

  // What the LLM wrote, in order, with whether each file existed, so a rejected attempt can be undone exactly.
  const changes: (FileChange & { created: boolean })[] = [];
  try {
    const proposal = await input.llm.fix({
      advisory,
      callSite,
      file: { path: callSite.file, content: original },
      test: { path: test.file, content: test.content },
      failingOutput: baseline.output,
    });
    if (proposal.status !== "proposed") {
      attempts.push({ method: "llm", outcome: "skipped", detail: proposal.reason });
      return rejected(ws, ran, baseline, attempts);
    }
    // A path given twice keeps its last content.
    const files = new Map<string, string>();
    for (const f of proposal.files) {
      const rel = path.posix.normalize(f.path.replaceAll("\\", "/"));
      const refusal = refuseWrite(rel, test.file);
      if (refusal) {
        attempts.push({ method: "llm", outcome: "failed", detail: `refused to write ${f.path}: ${refusal}` });
        return rejected(ws, ran, baseline, attempts);
      }
      files.delete(rel);
      files.set(rel, f.content);
    }
    const { run, typecheck } = await verify(async () => {
      for (const [rel, content] of files) {
        const before = await ws.read(rel);
        await ws.write(rel, content);
        changes.push({ file: rel, before: before ?? "", after: content, notes: [proposal.explanation], created: before === undefined });
      }
    });
    const keep = run.passed && typecheck?.status !== "failed" ? await keepCheck(changes.map(({ file, before, after }) => ({ file, before, after }))) : undefined;
    const kept = run.passed && typecheck?.status !== "failed" && keep?.status !== "removed";
    const detail = `${proposal.model}: ${proposal.explanation}`;
    attempts.push({ method: "llm", outcome: kept ? "passed" : "failed", detail: kept ? detail : failure(typecheck, keep, detail), run });
    if (kept) {
      return { status: "fixed", method: "llm", sandbox: ws.location, changes: [...changes.map(({ file, before, after, notes }) => ({ file, before, after, notes })), testChange], test: ran, baseline, attempts, typecheck, keep };
    }
  } catch (err) {
    // The sandbox is out of time: nothing more can run in it, so the caller decides what to deliver.
    if (err instanceof SandboxLifetimeError) throw err;
    // One bad proposal (a path that is a folder, an SDK error) fails this attempt, not the whole job.
    attempts.push({ method: "llm", outcome: "failed", detail: `the LLM attempt failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  await restore(ws, changes);
  return rejected(ws, ran, baseline, attempts);
}

/** Run `fn` in a temp copy of `repoDir` (it can hold the repository's .env files), removed afterwards. */
async function inTempCopy<T>(repoDir: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const ws = localWorkspace(repoDir);
  try {
    return await fn(ws);
  } finally {
    await ws.dispose();
  }
}

/** The message of a failure vitest reports with `mark` (the line it prints, not a code frame quoting the test). */
function marked(output: string, mark: string): string | undefined {
  return new RegExp(`^\\s*(?:→\\s*|[\\w$.]+: )${mark}: (.*)$`, "m").exec(output)?.[1]?.trim();
}

const SOURCE = /\.(c|m)?[jt]sx?$/;
/** A test file by name (`a.test.ts`, `a.spec.js`), or a file in a folder of tests. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);

/**
 * Why the LLM may not write `rel` (normalized, repo-relative), or undefined when it may. It may only
 * change source files: not the contract tests, config (vitest, tsconfig, package.json), setup files,
 * mocks, type declarations or CI, any of which could make a test pass without fixing the code. Nor the
 * repository's own tests (V-02): a fix that edits them could weaken what checks it.
 * Compared case-insensitively: on Windows and macOS `Test/Shapi/x.test.ts` is the contract test.
 */
function refuseWrite(rel: string, testFile: string): string | undefined {
  const lower = rel.toLowerCase();
  const parts = lower.split("/");
  const name = parts.at(-1) ?? "";
  if (rel.startsWith("..") || path.posix.isAbsolute(rel) || rel.includes(":")) return "outside the repository";
  if (lower === testFile.toLowerCase() || lower.startsWith(`${CONTRACT_DIR}/`)) return "the contract tests are not to be edited";
  if (parts.some((s) => PROTECTED.has(s) || s === ".github" || s === "__mocks__")) return "a protected folder";
  if (TEST_FILE.test(name) || parts.slice(0, -1).some((s) => TEST_DIRS.has(s))) return "the repository's tests are not to be edited";
  if (!SOURCE.test(name) || /\.d\.[cm]?ts$|\.config\.|setup|^(vitest|vite|jest)\./.test(name)) return "only source files may change (not config, setup, mocks or type declarations)";
  return undefined;
}

function rejected(ws: Workspace, test: { file: string; content: string }, baseline: TestRun, attempts: Attempt[]): RepairResult {
  return {
    status: "rejected",
    sandbox: ws.location,
    changes: [],
    test,
    baseline,
    attempts,
    reason: "no change made the contract test pass",
  };
}

/** Undo LLM-written files, last first: overwritten files get their content back, created ones are deleted. */
async function restore(ws: Workspace, changes: (FileChange & { created: boolean })[]): Promise<void> {
  for (const c of [...changes].reverse()) await (c.created ? ws.remove(c.file) : ws.write(c.file, c.before));
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
  /** The repository's own tests before and after the change, when any site was fixed. */
  suite?: SuiteCheck;
}

/** The repository's own test run before any change, or why there is none. */
async function suiteBaseline(ws: Workspace): Promise<{ run?: SuiteRun; unavailable?: string }> {
  if (!ws.runSuite) return { unavailable: "this workspace cannot run the repository's tests" };
  try {
    return { run: await ws.runSuite() };
  } catch (err) {
    return { unavailable: `the test command could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Repair every affected call site of one advisory in one workspace, so a single pull request covers
 * them all. Each site is repaired test-first like repairCallSite, on top of the fixes before it.
 * Within a file the sites go bottom-up, so an edit never moves the lines of a site still to come.
 * Each site gets its own contract test: test/shapi/<id>.test.ts, then <id>.2.test.ts, …
 */
export async function repairAdvisory(input: AdvisoryRepairInput): Promise<AdvisoryRepair> {
  if (!input.workspace && !input.repoDir) throw new Error("repairAdvisory needs a workspace or a repoDir");
  if (!input.workspace) return inTempCopy(input.repoDir!, (workspace) => repairAdvisory({ ...input, workspace }));
  const ws = input.workspace;
  const seen = new Set<string>();
  const order = input.callSites
    .filter((s) => {
      const key = `${s.file}:${s.line}:${s.column}`;
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .sort((a, b) => a.file.localeCompare(b.file) || b.line - a.line || b.column - a.column);

  // Before any change: the repository's tests as they stand, to tell a failure the change causes from one it found.
  const suiteBefore = await suiteBaseline(ws);
  const originals = new Map<string, string>();
  const sites: SiteRepair[] = [];
  for (const [i, callSite] of order.entries()) {
    if (!originals.has(callSite.file)) originals.set(callSite.file, (await ws.read(callSite.file)) ?? "");
    const testFile = `test/shapi/${input.advisory.id}${i === 0 ? "" : `.${i + 1}`}.test.ts`;
    const result = await repairCallSite({ ...input, workspace: ws, callSite, testFile });
    for (const c of result.changes) if (c.before && !originals.has(c.file)) originals.set(c.file, c.before);
    sites.push({ callSite, result });
  }

  // Each site's test ran right after its own change, and a later site's change can undo an earlier one:
  // with several fixes, every test runs again on the combined code, and a site whose test fails now is not fixed.
  const changed = sites.filter((s) => s.result.status === "fixed");
  if (changed.length > 1) {
    for (const s of changed) {
      const run = await ws.runTest(s.result.test!.file);
      if (run.passed && testsRan(run.output)) continue;
      s.result = {
        ...s.result,
        status: "rejected",
        reason: "its contract test fails on the combined change of all the call sites",
        attempts: [...s.result.attempts, { method: s.result.method!, outcome: "failed", detail: "contract test run again on the combined change", run }],
      };
    }
  }

  // The repository's own tests on the combined change (execution plan V-01). SHAPI's contract tests are set
  // aside while they run, so the repository's runner does not count them; a test that newly fails rejects every fix.
  let suite: SuiteCheck | undefined;
  const passing = sites.filter((s) => s.result.status === "fixed");
  if (passing.length) {
    suite = suiteBefore.unavailable
      ? { status: "not-run", detail: suiteBefore.unavailable }
      : await checkSuite(suiteBefore.run, async () => {
          const contract = passing.flatMap((s) => (s.result.test ? [s.result.test] : []));
          for (const t of contract) await ws.remove(t.file);
          await ws.remove(SHAPI_VITEST_CONFIG);
          try {
            return await ws.runSuite!();
          } finally {
            for (const t of contract) await ws.write(t.file, t.content);
          }
        });
    if (suite.status === "failed") {
      for (const s of passing) s.result = { ...s.result, status: "rejected", reason: `the repository's own tests fail after the change: ${suite.detail}` };
    }
  }

  const fixed = sites.filter((s) => s.result.status === "fixed");
  const needed = sites.filter((s) => s.result.status !== "already-handled");
  const tests = new Set(changed.map((s) => s.result.test?.file));
  // Source files come from every site that changed the code, so the change is exactly the tree that was tested.
  const sourceFiles = fixed.length === 0 ? [] : [...new Set(changed.flatMap((s) => s.result.changes.filter((c) => !tests.has(c.file)).map((c) => c.file)))].sort();
  const changes: FileChange[] = [];
  for (const file of sourceFiles) {
    const notes = changed.flatMap((s) => s.result.changes.filter((c) => c.file === file).flatMap((c) => c.notes));
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
    ...(suite ? { suite } : {}),
  };
}
