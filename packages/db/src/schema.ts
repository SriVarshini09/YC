import type { ColumnType, Generated, JSONColumnType } from "kysely";

/** Postgres `bigint` columns arrive as strings from `pg`; keep them as strings end to end. */
type Id = Generated<string>;
type CreatedAt = ColumnType<Date, string | Date | undefined, never>;
type Timestamp = ColumnType<Date, string | Date, string | Date>;

/** A GitHub App installation: one customer account (user or organization). Tenant root. */
export interface AccountsTable {
  id: Id;
  github_installation_id: ColumnType<string, string | number, string | number> | null;
  login: string;
  type: "User" | "Organization";
  settings: JSONColumnType<Record<string, unknown>>;
  created_at: CreatedAt;
  suspended_at: Timestamp | null;
}

export interface RepositoriesTable {
  id: Id;
  account_id: string;
  github_repo_id: ColumnType<string, string | number, string | number>;
  full_name: string;
  default_branch: string;
  private: boolean;
  enabled: Generated<boolean>;
  last_scan_sha: string | null;
  last_scanned_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface ScansTable {
  id: Id;
  account_id: string;
  repository_id: string;
  sha: string;
  status: "queued" | "running" | "succeeded" | "failed";
  api_lock: JSONColumnType<object> | null;
  error: string | null;
  created_at: CreatedAt;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface FindingsTable {
  id: Id;
  account_id: string;
  repository_id: string;
  scan_id: string;
  advisory_id: string;
  kind: "affected" | "exposed";
  call_site: JSONColumnType<object>;
  reasons: JSONColumnType<string[]>;
  created_at: CreatedAt;
}

/** Global, not per tenant: the advisory database. */
export interface AdvisoriesTable {
  id: string;
  provider: string;
  /** The full advisory (AdvisorySchema in @shapi/core). */
  data: JSONColumnType<object>;
  /** Human-reviewed (published) or a machine draft awaiting review, like GHSA's github_reviewed. */
  reviewed: boolean;
  /** Where it came from: "repo" (advisories/ folder), "canary", later "ingest:<source>". */
  source: string;
  modified: Timestamp;
}

/** Global: shapes observed by SHAPI's canaries (no customer data). */
export interface ObservationsTable {
  id: Id;
  provider: string;
  method: string;
  endpoint: string;
  observed_at: Timestamp;
  source: string;
  shape_hash: string;
  shape: JSONColumnType<object>;
}

/** Internal: every GitHub webhook delivery, keyed by X-GitHub-Delivery so redeliveries are idempotent. */
export interface WebhookDeliveriesTable {
  delivery_id: string;
  event: string;
  action: string | null;
  installation_id: ColumnType<string, string | number, string | number> | null;
  payload: JSONColumnType<object>;
  received_at: CreatedAt;
  processed_at: Timestamp | null;
  error: string | null;
}

export interface Database {
  accounts: AccountsTable;
  repositories: RepositoriesTable;
  scans: ScansTable;
  findings: FindingsTable;
  advisories: AdvisoriesTable;
  observations: ObservationsTable;
  webhook_deliveries: WebhookDeliveriesTable;
}

/** Tables holding one customer's data; row-level security keeps each customer to its own rows. */
export const TENANT_TABLES = ["accounts", "repositories", "scans", "findings"] as const;
