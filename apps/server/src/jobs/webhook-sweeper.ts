import type { Db } from "@shapi/db";
import { listRecentDeliveries, planRedeliveries, redeliver } from "@shapi/github-app";
import { sql } from "kysely";
import type { GitHubClients } from "../github/clients";

export interface SweepDeps {
  db: Db;
  /** Unset when the GitHub App is not configured: stored deliveries are still re-queued and pruned. */
  github?: GitHubClients;
  enqueue(deliveryId: string): Promise<void>;
  retentionDays: number;
  /** How far back to look for failed GitHub deliveries (GitHub keeps about three days). */
  lookbackHours?: number;
  now?: Date;
}

export interface SweepResult {
  requeued: number;
  redelivered: number;
  givenUp: number;
  /** Redeliveries GitHub refused (or the delivery list it could not give); the rest of the sweep still runs. */
  redeliveryFailed: number;
  failed: number;
  pruned: number;
}

/**
 * Keep webhooks from getting lost, since GitHub never retries a failed delivery:
 * 1. re-queue deliveries stored but never processed (the web process stored them but queueing failed),
 *    processed ones whose scans or fix jobs were never queued, and failed ones (after the job's own
 *    retries, for example during a GitHub outage) once an hour for a day after they arrived;
 * 2. ask GitHub to redeliver deliveries that never reached SHAPI (outage, timeout, bad deploy);
 * 3. delete processed payloads past the retention window.
 */
export async function sweepWebhooks(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const stale = new Date(now.getTime() - 2 * 60_000);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);

  const pending = await deps.db
    .selectFrom("webhook_deliveries")
    .select("delivery_id")
    .where("received_at", "<", stale)
    .where((eb) =>
      eb.or([
        eb.and([eb("processed_at", "is", null), eb("error", "is", null)]),
        eb.and([eb("processed_at", "is not", null), eb("jobs", "is not", null)]),
        eb.and([eb("processed_at", "is", null), eb("errored_at", "<", hourAgo), eb("received_at", ">", dayAgo)]),
      ]),
    )
    .orderBy("received_at")
    .limit(500)
    .execute();
  for (const row of pending) await deps.enqueue(row.delivery_id);

  const { failed } = await deps.db
    .selectFrom("webhook_deliveries")
    .select(sql<string>`count(*)`.as("failed"))
    .where("processed_at", "is", null)
    .where("error", "is not", null)
    .executeTakeFirstOrThrow();

  let redelivered = 0;
  let givenUp = 0;
  let redeliveryFailed = 0;
  if (deps.github) {
    const since = new Date(now.getTime() - (deps.lookbackHours ?? 24) * 3600_000);
    const attempts = await listRecentDeliveries(deps.github.app(), since).catch(() => {
      redeliveryFailed++;
      return [];
    });
    const guids = [...new Set(attempts.map((a) => a.guid))];
    const known = guids.length
      ? await deps.db.selectFrom("webhook_deliveries").select("delivery_id").where("delivery_id", "in", guids).execute()
      : [];
    const plan = planRedeliveries(attempts, { received: new Set(known.map((k) => k.delivery_id)) });
    for (const d of plan.redeliver) {
      // One attempt GitHub refuses (422, 404) must not stop the others, nor the pruning below.
      try {
        await redeliver(deps.github.app(), d.id);
        redelivered++;
      } catch {
        redeliveryFailed++;
      }
    }
    givenUp = plan.givenUp.length;
  }

  const cutoff = new Date(now.getTime() - deps.retentionDays * 86_400_000);
  const pruned = await deps.db
    .deleteFrom("webhook_deliveries")
    .where("processed_at", "is not", null)
    .where("processed_at", "<", cutoff)
    .executeTakeFirst();

  return { requeued: pending.length, redelivered, givenUp, redeliveryFailed, failed: Number(failed), pruned: Number(pruned.numDeletedRows) };
}
