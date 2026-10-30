import { z } from "zod";
import rawRegistry from "../tiers.json";
import { CHANGE_CLASSES, type Advisory, type ChangeClass } from "./advisory";

/**
 * Fix tiers (execution plan U-04): how far SHAPI trusts its fixes for one recipe × provider × change class cell.
 * - ALERT: no fix PR; the change is reported for a person to make.
 * - REVIEW: the fix PR opens as a draft.
 * - AUTO: the fix PR opens ready for review.
 * A cell starts at REVIEW and earns AUTO only from data: AUTO_AFTER benchmark instances fixed with no edit outside
 * the predicted lines, and no instance in the run that the fix failed. Merge outcomes and the founder can only lower
 * a tier, never raise it.
 */
export const TIERS = ["ALERT", "REVIEW", "AUTO"] as const;
export type Tier = (typeof TIERS)[number];

/** Benchmark passes a cell needs before its PRs open ready for review. */
export const AUTO_AFTER = 5;
/** PRs closed unmerged, more than merged, that lower a cell one tier. */
export const CLOSED_TO_DEMOTE = 3;
/** Change classes whose fixes always get a person's review: authentication and key handling. */
export const REVIEW_AT_MOST: readonly ChangeClass[] = ["auth", "scope-change"];

/** `recipe` is the advisory's recipe id, or "llm" for a fix Claude wrote. */
export interface TierCell {
  recipe: string;
  provider: string;
  changeClass: ChangeClass;
}

export const cellKey = (c: TierCell) => `${c.recipe}/${c.provider}/${c.changeClass}`;

/** The cell a fix falls in: its advisory's recipe, unless Claude wrote any part of it. */
export function cellOf(advisory: Pick<Advisory, "recipeId" | "provider" | "changeClass">, method?: "recipe" | "llm"): TierCell {
  return { recipe: method === "llm" || !advisory.recipeId ? "llm" : advisory.recipeId, provider: advisory.provider, changeClass: advisory.changeClass };
}

/** One benchmark instance's fix in a cell. */
export interface BenchmarkFix {
  id: string;
  outcome: "fixed" | "partial" | "not-fixed" | "error";
  /** Call sites whose fix edited outside the predicted lines (V-05). */
  outOfScope?: number;
}

/** A founder's demotion of a cell, with why. A demotion can only lower a tier (the schema has no AUTO). */
export const DemotionSchema = z.object({ tier: z.enum(["ALERT", "REVIEW"]), reason: z.string().min(1) });
export const DemotionsSchema = z.record(z.string(), DemotionSchema);
export type Demotions = z.infer<typeof DemotionsSchema>;

export interface TierEvidence {
  benchmark: BenchmarkFix[];
  /** Fix PRs in this cell that were merged, and closed without merging. */
  prs?: { merged: number; closed: number };
  demotion?: z.infer<typeof DemotionSchema>;
}

export interface TierDecision {
  tier: Tier;
  /** The benchmark instances that earned it: the passes behind an AUTO cell. */
  passes: string[];
  /** Instances in the run whose fix failed or edited outside the predicted lines. */
  failures: string[];
  /** Why the cell has this tier, in order. */
  reasons: string[];
}

const RANK: Record<Tier, number> = { ALERT: 0, REVIEW: 1, AUTO: 2 };
const lower = (a: Tier, b: Tier): Tier => (RANK[a] <= RANK[b] ? a : b);

export function earnTier(cell: TierCell, evidence: TierEvidence): TierDecision {
  const passes = evidence.benchmark.filter((b) => b.outcome === "fixed" && !b.outOfScope).map((b) => b.id);
  // "error" means the code could not be fetched or set up; that says nothing about the fix.
  const failures = evidence.benchmark.filter((b) => b.outcome !== "error" && (b.outcome !== "fixed" || b.outOfScope)).map((b) => b.id);
  const reasons: string[] = [];
  let tier: Tier = "REVIEW";
  if (passes.length >= AUTO_AFTER && !failures.length) {
    tier = "AUTO";
    reasons.push(`${passes.length} benchmark instances fixed with no edit outside the predicted lines`);
  } else {
    reasons.push(
      failures.length
        ? `${failures.length} benchmark instance${failures.length === 1 ? "" : "s"} not fixed cleanly`
        : `${passes.length} of the ${AUTO_AFTER} benchmark passes AUTO needs`,
    );
  }
  if (tier === "AUTO" && REVIEW_AT_MOST.includes(cell.changeClass)) {
    tier = "REVIEW";
    reasons.push(`${cell.changeClass} changes always get a person's review`);
  }
  const prs = evidence.prs;
  if (prs && prs.closed >= CLOSED_TO_DEMOTE && prs.closed > prs.merged) {
    tier = tier === "AUTO" ? "REVIEW" : "ALERT";
    reasons.push(`${prs.closed} fix PRs closed without merging, ${prs.merged} merged`);
  }
  if (evidence.demotion && RANK[evidence.demotion.tier] < RANK[tier]) {
    tier = lower(tier, evidence.demotion.tier);
    reasons.push(`demoted: ${evidence.demotion.reason}`);
  }
  return { tier, passes, failures, reasons };
}

/** The draft flag a fix PR opens with: REVIEW opens a draft, AUTO a ready PR. ALERT opens none. */
export const opensAsDraft = (tier: Tier) => tier !== "AUTO";

const BenchmarkFixSchema = z.object({ id: z.string(), outcome: z.enum(["fixed", "partial", "not-fixed", "error"]), outOfScope: z.number().int().optional() });

/** packages/core/tiers.json: every cell's benchmark evidence and founder demotion, and the tier they earn. */
export const TierRegistrySchema = z.object({
  /** The benchmark run the evidence comes from. */
  benchmark: z.object({ dataset: z.string(), shapiVersion: z.string(), runAt: z.string() }),
  autoAfter: z.number().int(),
  cells: z.array(
    z.object({
      recipe: z.string(),
      provider: z.string(),
      changeClass: z.enum(CHANGE_CLASSES),
      benchmark: z.array(BenchmarkFixSchema),
      demotion: DemotionSchema.optional(),
      tier: z.enum(TIERS),
      passes: z.array(z.string()),
      failures: z.array(z.string()),
      reasons: z.array(z.string()),
    }),
  ),
});
export type TierRegistry = z.infer<typeof TierRegistrySchema>;

export const TIER_REGISTRY: TierRegistry = TierRegistrySchema.parse(rawRegistry);

/**
 * A cell's tier for one account: the registry's benchmark evidence and demotion, lowered by that account's own merge
 * outcomes in the cell. A cell the registry doesn't list has no benchmark evidence, so it is REVIEW.
 */
export function tierFor(cell: TierCell, prs?: { merged: number; closed: number }, registry: TierRegistry = TIER_REGISTRY): TierDecision {
  const entry = registry.cells.find((c) => cellKey(c) === cellKey(cell));
  return earnTier(cell, { benchmark: entry?.benchmark ?? [], ...(entry?.demotion ? { demotion: entry.demotion } : {}), ...(prs ? { prs } : {}) });
}
