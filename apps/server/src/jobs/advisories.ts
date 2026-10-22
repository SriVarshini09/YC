import { loadAdvisories } from "@shapi/core";
import { upsertAdvisories, type Db } from "@shapi/db";

/** Load the reviewed advisories shipped in the advisories/ folder into the database. Safe to run on every start. */
export async function syncAdvisoriesJob(db: Db, dir: string): Promise<number> {
  return upsertAdvisories(db, loadAdvisories(dir), { reviewed: true, source: "repo" });
}
