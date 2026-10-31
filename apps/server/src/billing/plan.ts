import { withService, type Tx } from "@shapi/db";
import type { Db } from "@shapi/db";
import { COMMITTER_WINDOW_DAYS, activeCommitters } from "./committers";

/**
 * Active committers every account gets free (execution plan I-03): people who committed to its private repositories
 * in the last 90 days. Public repositories are always free. A placeholder until the plan's numbers are set; the
 * price per committer lives in Stripe, not here.
 */
export const FREE_COMMITTERS = 3;

/** Stripe statuses that keep paid repositories covered (past_due: Stripe is still retrying the payment). */
const PAYING = new Set(["active", "trialing", "past_due"]);

export interface PlanRepo {
  id: string;
  private: boolean;
  enabled: boolean;
  created_at: Date;
  /** Hashes of its committers in the last 90 days (see countCommitters). */
  committers?: string[];
}

export interface PlanBilling {
  status: string;
  quantity: number;
}

export type Coverage = { covered: true; by: "public" | "free" | "paid" | "unlimited" } | { covered: false; reason: string };

export { activeCommitters };

/** Seats the account pays for: its active committers beyond the free ones. */
export function requiredQuantity(repos: PlanRepo[]): number {
  return Math.max(0, activeCommitters(repos) - FREE_COMMITTERS);
}

/**
 * Which repositories SHAPI works on. Public ones always. Private ones while the account's active committers fit the
 * plan: the free ones, plus `quantity` seats while the subscription is paying. Beyond that no private repository is
 * covered until the plan grows. Without billing configured (local development, self-hosting) everything is covered.
 */
export function coverage(repos: PlanRepo[], billing: PlanBilling | undefined, enforced: boolean): Map<string, Coverage> {
  const out = new Map<string, Coverage>();
  if (!enforced) {
    for (const r of repos) out.set(r.id, { covered: true, by: "unlimited" });
    return out;
  }
  const paid = billing && PAYING.has(billing.status) ? billing.quantity : 0;
  const committers = activeCommitters(repos);
  const fits = committers <= FREE_COMMITTERS + paid;
  const people = `${committers} ${committers === 1 ? "person" : "people"} committed to private repositories in the last ${COMMITTER_WINDOW_DAYS} days`;
  const reason = paid ? `${people}; the plan covers ${FREE_COMMITTERS + paid}` : `${people}; the free plan covers ${FREE_COMMITTERS}`;
  for (const r of repos) {
    if (!r.enabled) out.set(r.id, { covered: false, reason: "repository archived" });
    else if (!r.private) out.set(r.id, { covered: true, by: "public" });
    else if (fits) out.set(r.id, { covered: true, by: committers <= FREE_COMMITTERS ? "free" : "paid" });
    else out.set(r.id, { covered: false, reason });
  }
  return out;
}

async function loadPlan(tx: Tx, accountId: string) {
  const repos = await tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at", "committers"]).where("account_id", "=", accountId).execute();
  const billing = await tx.selectFrom("billing").select(["status", "quantity"]).where("account_id", "=", accountId).executeTakeFirst();
  return { repos, billing };
}

/** Whether the plan covers one repository (for the scan and fix jobs, which run as the service). */
export async function repositoryCovered(db: Db, accountId: string, repositoryId: string, enforced: boolean): Promise<Coverage> {
  if (!enforced) return { covered: true, by: "unlimited" };
  const { repos, billing } = await withService(db, (tx) => loadPlan(tx, accountId));
  return coverage(repos, billing, enforced).get(repositoryId) ?? { covered: false, reason: "repository not found" };
}

export { loadPlan };
