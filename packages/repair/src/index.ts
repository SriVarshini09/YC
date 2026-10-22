import type { Recipe } from "./recipe";
import { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

export * from "./recipe";
export { statusCodeAcceptSet } from "./recipes/status-code-accept-set";

/** Every recipe, by id (advisories name one in `recipeId`). */
export const RECIPES: Record<string, Recipe> = {
  [statusCodeAcceptSet.id]: statusCodeAcceptSet,
};
