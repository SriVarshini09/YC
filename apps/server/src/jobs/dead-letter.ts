import { withService, type Db } from "@shapi/db";

/**
 * A job that failed every attempt. pg-boss copies it to the dead-letter queue with the queue it came from,
 * its retries and its last error (execution plan I-02).
 */
export interface DeadJob {
  queue: string | null;
  id: string | null;
  /** Retries the original job used; its attempts are one more. */
  retries: number | null;
  data: unknown;
  /** The original job's output when it failed: the error pg-boss serialized, or what its supervisor wrote. */
  output: unknown;
}

/** The last error of a dead job, as one line. */
export function deadJobError(output: unknown): string {
  if (output && typeof output === "object") {
    const o = output as { message?: unknown; value?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.value === "string" && o.value) return o.value;
  }
  if (typeof output === "string" && output) return output;
  return output === null || output === undefined ? "no error recorded" : JSON.stringify(output).slice(0, 300);
}

/**
 * Settle what a dead job leaves behind. A scan job's scan is marked failed with the reason, so the dashboard
 * shows it and the sweep does not queue it again. Every dead job is reported by the caller (Sentry).
 */
export async function settleDeadJob(db: Db, job: DeadJob, scanQueue: string, now = new Date()): Promise<{ attempts: number; error: string; scanFailed?: string }> {
  const attempts = (job.retries ?? 0) + 1;
  const error = deadJobError(job.output);
  const scanId = job.queue === scanQueue ? (job.data as { scanId?: unknown } | null)?.scanId : undefined;
  if (typeof scanId !== "string") return { attempts, error };
  const failed = await withService(db, (tx) =>
    tx
      .updateTable("scans")
      .set({ status: "failed", error: `SHAPI gave up on this scan after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${error}`.slice(0, 2000), finished_at: now })
      .where("id", "=", scanId)
      .where("status", "in", ["queued", "running"])
      .returning("id")
      .executeTakeFirst(),
  );
  return { attempts, error, ...(failed ? { scanFailed: failed.id } : {}) };
}
