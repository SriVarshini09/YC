import type { Recipe } from "./recipe";
import { applyFix } from "./recipes/apply-fix";
import { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

export * from "./recipe";
export * from "./contract";
export * from "./agent";
export * from "./workspace";
export { DEFAULT_REPAIR_MODEL, claudeFixer, type FixProposal, type FixRequest, type LlmFixer } from "./llm";
export { runFailure, runTestFile, testsRan, type TestRun } from "./runner";
export { bodyFromPaths, synthesizeBody } from "./synth";
export { statusCodeAcceptSet } from "./recipes/status-code-accept-set";
export { applyFix } from "./recipes/apply-fix";

/** Every recipe, by id (advisories name one in `recipeId`). */
export const RECIPES: Record<string, Recipe> = {
  [statusCodeAcceptSet.id]: statusCodeAcceptSet,
  [applyFix.id]: applyFix,
};
