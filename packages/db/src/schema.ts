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
  /** Dashboard state: { paused, createNow: advisory ids, retry: advisory ids }. */
  settings: ColumnType<Record<string, unknown>, string | undefined, string>;
  dashboard_issue: number | null;
}

export interface ScansTable {
  id: Id;
  account_id: string;
  repository_id: string;
  sha: string;
  status: "queued" | "running" | "succeeded" | "failed";
  api_lock: JSONColumnType<object> | null;
  error: string | null;
  check_run_id: ColumnType<string, string | number, string | number> | null;
  /** Advisory id -> modified time of every advisory this scan's api.lock was matched against. */
  advisories: ColumnType<Record<string, string>, string | undefined, string>;
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

/** One fix PR per (repository, advisory): its deterministic branch and what happened to it. */
export interface FixPrsTable {
  id: Id;
  account_id: string;
  repository_id: string;
  advisory_id: string;
  branch: string;
  number: number | null;
  url: string | null;
  state: "open" | "closed" | "merged";
  stopped: Generated<boolean>;
  head_sha: string | null;
  /** When the current PR was opened (reset when a closed fix is reopened from the dashboard); drives the hourly limit. */
  created_at: ColumnType<Date, string | Date | undefined, string | Date>;
  updated_at: Timestamp;
  closed_at: Timestamp | null;
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

/** An account's Stripe subscription: how many private repositories beyond the free one are paid for. */
export interface BillingTable {
  account_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** Stripe's subscription status, or "none" before the first checkout. */
  status: Generated<string>;
  quantity: Generated<number>;
  current_period_end: Timestamp | null;
  updated_at: Timestamp;
}

/** Internal: Stripe webhook events already applied, so a redelivery is a no-op. */
export interface StripeEventsTable {
  id: string;
  type: string;
  received_at: CreatedAt;
}

/** Internal: a signed-in web session. The cookie holds the token; this row holds its SHA-256. */
export interface SessionsTable {
  token_hash: string;
  github_user_id: ColumnType<string, string | number, string | number>;
  login: string;
  /** GitHub App installations the user could access when signing in: the accounts the session may open. */
  installation_ids: ColumnType<string[], string, string>;
  csrf: string;
  created_at: CreatedAt;
  expires_at: Timestamp;
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
  fix_prs: FixPrsTable;
  advisories: AdvisoriesTable;
  observations: ObservationsTable;
  webhook_deliveries: WebhookDeliveriesTable;
  sessions: SessionsTable;
  billing: BillingTable;
  stripe_events: StripeEventsTable;
}

/** Tables holding one customer's data; row-level security keeps each customer to its own rows. */
export const TENANT_TABLES = ["accounts", "repositories", "scans", "findings", "fix_prs", "billing"] as const;
