import type { Recipe } from "./recipe";
import { applyFix } from "./recipes/apply-fix";
import { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

export * from "./recipe";
export * from "./contract";
export * from "./agent";
export * from "./workspace";
export { DEFAULT_LLM_CALLS_PER_JOB, DEFAULT_REPAIR_MODEL, MAX_LLM_FILE_BYTES, claudeFixer, withCallBudget, type FixProposal, type FixRequest, type LlmFixer } from "./llm";
export { SHAPI_VITEST_CONFIG, runFailure, runTestFile, testCounts, testsRan, type TestRun } from "./runner";
export { checkKept, type KeepCheck, type KeepInput } from "./keep";
export { checkTypes, tscErrors, typeBaseline, type TypeBaseline, type TypeCheck } from "./typecheck";
export { SUITE_ATTEMPTS, checkSuite, failingTests, suiteCommand, suiteCounts, testTotal, type SuiteCheck, type SuiteRun } from "./suite";
export { bodyFromPaths, synthesizeBody } from "./synth";
export { statusCodeAcceptSet } from "./recipes/status-code-accept-set";
export { applyFix } from "./recipes/apply-fix";

/** Every recipe, by id (advisories name one in `recipeId`). */
export const RECIPES: Record<string, Recipe> = {
  [statusCodeAcceptSet.id]: statusCodeAcceptSet,
  [applyFix.id]: applyFix,
};
