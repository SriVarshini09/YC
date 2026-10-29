import type { Octokit } from "@octokit/rest";

/** One delivery attempt as listed by `GET /app/hook/deliveries`. Redeliveries keep the original guid. */
export interface HookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  /** 0 when GitHub got no response (timeout or connection error). */
  status_code: number;
  event: string;
  action?: string | null;
}

export interface RedeliveryPlan {
  /** Latest failed attempt per guid that should be retried. */
  redeliver: HookDelivery[];
  /** Guids that failed on every attempt and hit the attempt limit; reported, not retried. */
  givenUp: string[];
}

/**
 * GitHub never retries a failed webhook delivery by itself, so a sweeper has to. A guid is retried
 * when no attempt got a 2xx, SHAPI has no record of receiving it, and it has had fewer than
 * `maxAttempts` attempts. A guid whose original attempt is older than the listed window is not
 * retried: its earlier attempts cannot be counted. At most `limit` redeliveries per sweep, oldest first.
 */
export function planRedeliveries(
  deliveries: HookDelivery[],
  opts: { received: ReadonlySet<string>; maxAttempts?: number; limit?: number },
): RedeliveryPlan {
  const maxAttempts = opts.maxAttempts ?? 3;
  const limit = opts.limit ?? 50;
  const byGuid = new Map<string, HookDelivery[]>();
  for (const d of deliveries) byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);

  const redeliver: HookDelivery[] = [];
  const givenUp: string[] = [];
  for (const [guid, attempts] of byGuid) {
    if (opts.received.has(guid)) continue;
    if (attempts.some((a) => a.status_code >= 200 && a.status_code < 300)) continue;
    if (attempts.length >= maxAttempts || attempts.every((a) => a.redelivery)) {
      givenUp.push(guid);
      continue;
    }
    const latest = attempts.reduce((a, b) => (a.delivered_at >= b.delivered_at ? a : b));
    redeliver.push(latest);
  }
  redeliver.sort((a, b) => a.delivered_at.localeCompare(b.delivered_at));
  return { redeliver: redeliver.slice(0, limit), givenUp };
}

/** Delivery attempts newer than `since`, newest first (GitHub keeps about three days of them). */
export async function listRecentDeliveries(octokit: Octokit, since: Date): Promise<HookDelivery[]> {
  const out: HookDelivery[] = [];
  for await (const page of octokit.paginate.iterator("GET /app/hook/deliveries", { per_page: 100 })) {
    const items = page.data as HookDelivery[];
    for (const d of items) {
      if (new Date(d.delivered_at) < since) return out;
      out.push(d);
    }
  }
  return out;
}

/** Ask GitHub to send a delivery again. */
export async function redeliver(octokit: Octokit, deliveryId: number): Promise<void> {
  await octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: deliveryId });
}
