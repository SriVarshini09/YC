import type { Recipe } from "./recipe";
import { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

export * from "./recipe";
export * from "./contract";
export * from "./agent";
export { DEFAULT_REPAIR_MODEL, claudeFixer, type FixProposal, type FixRequest, type LlmFixer } from "./llm";
export { runTestFile, type TestRun } from "./runner";
export { synthesizeBody } from "./synth";
export { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

/** Every recipe, by id (advisories name one in `recipeId`). */
export const RECIPES: Record<string, Recipe> = {
  [statusCodeAcceptSet.id]: statusCodeAcceptSet,
};
