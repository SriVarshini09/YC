import { withService, type Tx } from "@shapi/db";
import type { Db } from "@shapi/db";

/** Private repositories every account gets free. Public repositories are always free. */
export const FREE_PRIVATE_REPOS = 1;

/** Stripe statuses that keep paid repositories covered (past_due: Stripe is still retrying the payment). */
const PAYING = new Set(["active", "trialing", "past_due"]);

export interface PlanRepo {
  id: string;
  private: boolean;
  enabled: boolean;
  created_at: Date;
}

export interface PlanBilling {
  status: string;
  quantity: number;
}

export type Coverage = { covered: true; by: "public" | "free" | "paid" | "unlimited" } | { covered: false; reason: string };

/** Private repositories the account pays for beyond the free one. */
export function requiredQuantity(repos: PlanRepo[]): number {
  return Math.max(0, repos.filter((r) => r.private && r.enabled).length - FREE_PRIVATE_REPOS);
}

/**
 * Which repositories SHAPI works on. Public ones always; the oldest private one free; the next
 * `quantity` private ones while the subscription is paying; the rest wait for the plan to grow.
 * Without billing configured (local development, self-hosting) everything is covered.
 */
export function coverage(repos: PlanRepo[], billing: PlanBilling | undefined, enforced: boolean): Map<string, Coverage> {
  const out = new Map<string, Coverage>();
  if (!enforced) {
    for (const r of repos) out.set(r.id, { covered: true, by: "unlimited" });
    return out;
  }
  const paid = billing && PAYING.has(billing.status) ? billing.quantity : 0;
  const privates = repos.filter((r) => r.private && r.enabled).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || Number(a.id) - Number(b.id));
  for (const r of repos) if (!r.private) out.set(r.id, { covered: true, by: "public" });
  privates.forEach((r, i) => {
    if (i < FREE_PRIVATE_REPOS) out.set(r.id, { covered: true, by: "free" });
    else if (i < FREE_PRIVATE_REPOS + paid) out.set(r.id, { covered: true, by: "paid" });
    else out.set(r.id, { covered: false, reason: paid ? "beyond the private repositories in your plan" : "the free plan covers one private repository" });
  });
  for (const r of repos) if (!out.has(r.id)) out.set(r.id, { covered: false, reason: "repository archived" });
  return out;
}

async function loadPlan(tx: Tx, accountId: string) {
  const repos = await tx.selectFrom("repositories").select(["id", "private", "enabled", "created_at"]).where("account_id", "=", accountId).execute();
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
