import { sql, type Kysely } from "kysely";
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";

/** The role the application runs as. It owns nothing and cannot bypass row-level security. */
export const APP_ROLE = "shapi_app";

/**
 * Row-level security predicate: a row is visible when it belongs to the account set for this
 * transaction (`app.account_id`, set by withTenant), or when the transaction runs as the service
 * (`app.service = on`, set by withService for cross-tenant background work).
 */
const tenantPredicate = (column: string) =>
  sql.raw(
    `${column} = nullif(current_setting('app.account_id', true), '')::bigint or current_setting('app.service', true) = 'on'`,
  );

const migrations: Record<string, Migration> = {
  "0001_init": {
    async up(db: Kysely<unknown>) {
      await sql`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = ${sql.lit(APP_ROLE)}) then
            create role ${sql.raw(APP_ROLE)} nologin nobypassrls;
          end if;
        end $$;
      `.execute(db);
      // The connecting user switches to the app role on every connection (see createDb).
      await sql`grant ${sql.raw(APP_ROLE)} to current_user`.execute(db);

      await sql`
        create table accounts (
          id bigserial primary key,
          github_installation_id bigint unique,
          login text not null,
          type text not null check (type in ('User', 'Organization')),
          settings jsonb not null default '{}',
          created_at timestamptz not null default now(),
          suspended_at timestamptz
        );
        create table repositories (
          id bigserial primary key,
          account_id bigint not null references accounts on delete cascade,
          github_repo_id bigint not null unique,
          full_name text not null,
          default_branch text not null,
          private boolean not null,
          enabled boolean not null default true,
          last_scan_sha text,
          last_scanned_at timestamptz,
          created_at timestamptz not null default now()
        );
        create index repositories_account on repositories (account_id);
        create table scans (
          id bigserial primary key,
          account_id bigint not null references accounts on delete cascade,
          repository_id bigint not null references repositories on delete cascade,
          sha text not null,
          status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
          api_lock jsonb,
          error text,
          created_at timestamptz not null default now(),
          started_at timestamptz,
          finished_at timestamptz
        );
        create index scans_repository on scans (repository_id, created_at desc);
        create table findings (
          id bigserial primary key,
          account_id bigint not null references accounts on delete cascade,
          repository_id bigint not null references repositories on delete cascade,
          scan_id bigint not null references scans on delete cascade,
          advisory_id text not null,
          kind text not null check (kind in ('affected', 'exposed')),
          call_site jsonb not null,
          reasons jsonb not null,
          created_at timestamptz not null default now()
        );
        create index findings_repository on findings (repository_id, created_at desc);
        create index findings_advisory on findings (advisory_id);

        create table advisories (
          id text primary key,
          provider text not null,
          data jsonb not null,
          reviewed boolean not null,
          source text not null,
          modified timestamptz not null
        );
        create index advisories_provider on advisories (provider);
        create table observations (
          id bigserial primary key,
          provider text not null,
          method text not null,
          endpoint text not null,
          observed_at timestamptz not null,
          source text not null,
          shape_hash text not null,
          shape jsonb not null
        );
        create index observations_endpoint on observations (provider, method, endpoint, source, observed_at desc);
        create table webhook_deliveries (
          delivery_id text primary key,
          event text not null,
          action text,
          installation_id bigint,
          payload jsonb not null,
          received_at timestamptz not null default now(),
          processed_at timestamptz,
          error text
        );
      `.execute(db);

      // Tenant tables: on, forced (applies to the owner too), one policy per table.
      for (const table of ["repositories", "scans", "findings"]) {
        await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
        await sql`alter table ${sql.table(table)} force row level security`.execute(db);
        await sql`create policy tenant_isolation on ${sql.table(table)} using (${tenantPredicate("account_id")}) with check (${tenantPredicate("account_id")})`.execute(db);
      }
      await sql`alter table accounts enable row level security`.execute(db);
      await sql`alter table accounts force row level security`.execute(db);
      await sql`create policy tenant_isolation on accounts using (${tenantPredicate("id")}) with check (${tenantPredicate("id")})`.execute(db);

      await sql`grant usage on schema public to ${sql.raw(APP_ROLE)}`.execute(db);
      await sql`grant select, insert, update, delete on all tables in schema public to ${sql.raw(APP_ROLE)}`.execute(db);
      await sql`grant usage, select on all sequences in schema public to ${sql.raw(APP_ROLE)}`.execute(db);
      // Tables and sequences added by later migrations get the same grants.
      await sql`alter default privileges in schema public grant select, insert, update, delete on tables to ${sql.raw(APP_ROLE)}`.execute(db);
      await sql`alter default privileges in schema public grant usage, select on sequences to ${sql.raw(APP_ROLE)}`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists findings, scans, repositories, accounts, advisories, observations, webhook_deliveries cascade`.execute(db);
    },
  },
  "0002_webhook_sweeper": {
    // The sweeper looks for unprocessed deliveries and prunes old processed ones.
    async up(db: Kysely<unknown>) {
      await sql`
        create index webhook_deliveries_unprocessed on webhook_deliveries (received_at) where processed_at is null;
        create index webhook_deliveries_processed on webhook_deliveries (processed_at) where processed_at is not null;
        create index scans_pending on scans (repository_id, sha) where status in ('queued', 'running');
      `.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop index if exists webhook_deliveries_unprocessed, webhook_deliveries_processed, scans_pending`.execute(db);
    },
  },
  "0003_fix_prs": {
    // The PR engine: one row per (repository, advisory) fix PR, plus per-repository settings and the dashboard issue.
    async up(db: Kysely<unknown>) {
      await sql`
        alter table repositories add column settings jsonb not null default '{}';
        alter table repositories add column dashboard_issue integer;
        create table fix_prs (
          id bigserial primary key,
          account_id bigint not null references accounts on delete cascade,
          repository_id bigint not null references repositories on delete cascade,
          advisory_id text not null,
          branch text not null,
          number integer,
          url text,
          state text not null check (state in ('open', 'closed', 'merged')),
          stopped boolean not null default false,
          head_sha text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          closed_at timestamptz,
          unique (repository_id, advisory_id)
        );
        create index fix_prs_branch on fix_prs (repository_id, branch);
      `.execute(db);
      await sql`alter table fix_prs enable row level security`.execute(db);
      await sql`alter table fix_prs force row level security`.execute(db);
      await sql`create policy tenant_isolation on fix_prs using (${tenantPredicate("account_id")}) with check (${tenantPredicate("account_id")})`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists fix_prs`.execute(db);
      await sql`alter table repositories drop column if exists settings, drop column if exists dashboard_issue`.execute(db);
    },
  },
  "0004_cloud_scans": {
    // Cloud scans: the check run posted for each scan, and which advisory versions it was matched against.
    async up(db: Kysely<unknown>) {
      await sql`
        alter table scans add column check_run_id bigint;
        alter table scans add column advisories jsonb not null default '{}';
        create index scans_latest on scans (repository_id, finished_at desc) where status = 'succeeded';
      `.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop index if exists scans_latest`.execute(db);
      await sql`alter table scans drop column if exists check_run_id, drop column if exists advisories`.execute(db);
    },
  },
  "0005_web_sessions": {
    // Web app sign-in. Only a hash of the session token is stored; the GitHub user token is never kept.
    async up(db: Kysely<unknown>) {
      await sql`
        create table sessions (
          token_hash text primary key,
          github_user_id bigint not null,
          login text not null,
          installation_ids jsonb not null,
          csrf text not null,
          created_at timestamptz not null default now(),
          expires_at timestamptz not null
        );
        create index sessions_expiry on sessions (expires_at);
      `.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists sessions`.execute(db);
    },
  },
  "0006_billing": {
    // Stripe billing: one subscription per account, priced per private repository beyond the free one.
    async up(db: Kysely<unknown>) {
      await sql`
        create table billing (
          account_id bigint primary key references accounts on delete cascade,
          stripe_customer_id text unique,
          stripe_subscription_id text unique,
          status text not null default 'none',
          quantity integer not null default 0,
          current_period_end timestamptz,
          updated_at timestamptz not null default now()
        );
        create table stripe_events (
          id text primary key,
          type text not null,
          received_at timestamptz not null default now()
        );
      `.execute(db);
      await sql`alter table billing enable row level security`.execute(db);
      await sql`alter table billing force row level security`.execute(db);
      await sql`create policy tenant_isolation on billing using (${tenantPredicate("account_id")}) with check (${tenantPredicate("account_id")})`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists billing, stripe_events`.execute(db);
    },
  },
  "0007_billing_cancel_at": {
    // When a cancelled subscription ends (Stripe's cancel_at, or the period end with cancel_at_period_end).
    async up(db: Kysely<unknown>) {
      await sql`alter table billing add column cancel_at timestamptz`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table billing drop column if exists cancel_at`.execute(db);
    },
  },
  "0008_fix_pr_repair": {
    // What the fix PR changed and how it was verified (diff per file, contract test before and after), for the web app's finding page.
    async up(db: Kysely<unknown>) {
      await sql`alter table fix_prs add column repair jsonb`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table fix_prs drop column if exists repair`.execute(db);
    },
  },
  "0009_findings_scan_index": {
    // Every account page reads the findings of each repository's latest scan by scan id.
    async up(db: Kysely<unknown>) {
      await sql`create index if not exists findings_scan on findings (scan_id)`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop index if exists findings_scan`.execute(db);
    },
  },
  "0010_scans_fix_engine": {
    // The SHAPI build that last ran the fix job on a scan: a new build retries the fixes an older one could not make.
    async up(db: Kysely<unknown>) {
      await sql`alter table scans add column fix_engine text`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table scans drop column if exists fix_engine`.execute(db);
    },
  },
  "0011_session_repo_access": {
    // What a signed-in user may see and manage: per installation, the repositories they can read, push to
    // and administer on GitHub, read at sign-in. Older sessions lack it, so they end: users sign in again.
    async up(db: Kysely<unknown>) {
      await sql`delete from sessions`.execute(db);
      // The default (no access) covers sessions an old machine still creates while a deploy rolls out.
      await sql`alter table sessions add column access jsonb not null default '{}'::jsonb`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table sessions drop column if exists access`.execute(db);
    },
  },
  "0013_jobs_fixes": {
    async up(db: Kysely<unknown>) {
      // The jobs a processed delivery still has to queue (cleared once queued), and when it last failed (the sweeper retries it hourly).
      await sql`alter table webhook_deliveries add column jobs jsonb, add column errored_at timestamptz`.execute(db);
      // One pending scan per commit: two deliveries (or workers) racing for the same commit cannot both queue one.
      await sql`
        update scans set status = 'failed', error = 'duplicate of another scan of this commit', finished_at = now()
        where id in (
          select id from (select id, row_number() over (partition by repository_id, sha order by id) as n from scans where status in ('queued', 'running')) d
          where n > 1
        )
      `.execute(db);
      await sql`drop index if exists scans_pending`.execute(db);
      await sql`create unique index scans_pending on scans (repository_id, sha) where status in ('queued', 'running')`.execute(db);
      // The app role has no business with the migration bookkeeping that 0001's "all tables" grant included.
      await sql`revoke all on kysely_migration, kysely_migration_lock from ${sql.raw(APP_ROLE)}`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table webhook_deliveries drop column if exists jobs, drop column if exists errored_at`.execute(db);
      await sql`drop index if exists scans_pending`.execute(db);
      await sql`create index scans_pending on scans (repository_id, sha) where status in ('queued', 'running')`.execute(db);
      await sql`grant select, insert, update, delete on kysely_migration, kysely_migration_lock to ${sql.raw(APP_ROLE)}`.execute(db);
    },
  },
  // 0012 was never used: a migration added after 0013 ran must sort after it (Kysely refuses unordered ones).
  "0014_scans_llm_calls": {
    async up(db: Kysely<unknown>) {
      // LLM calls the fix jobs of a scan made, so retried jobs share one budget (see withCallBudget).
      await sql`alter table scans add column llm_calls integer not null default 0`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table scans drop column if exists llm_calls`.execute(db);
    },
  },
  "0015_fix_job_llm_calls": {
    async up(db: Kysely<unknown>) {
      // LLM calls per fix job (pg-boss job id), so a job's retries share one budget and every new job gets its own.
      // scans.llm_calls (0014) is no longer used; it stays while older machines of a rolling deploy may still write it.
      await sql`
        create table fix_job_llm_calls (
          job_id text primary key,
          calls integer not null,
          created_at timestamptz not null default now()
        )
      `.execute(db);
      // When the newest default-branch push SHAPI took was made (GitHub's pushed_at): an older push delivered late is not scanned.
      await sql`alter table repositories add column last_pushed_at timestamptz`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists fix_job_llm_calls`.execute(db);
      await sql`alter table repositories drop column if exists last_pushed_at`.execute(db);
    },
  },
  "0016_pr_feedback": {
    async up(db: Kysely<unknown>) {
      // The 👍/👎 links in fix PRs (D-01): one row per click, from a signed link. Who clicked is not known or kept.
      await sql`
        create table pr_feedback (
          id bigserial primary key,
          account_id bigint not null references accounts on delete cascade,
          repository_id bigint not null references repositories on delete cascade,
          advisory_id text not null,
          vote text not null check (vote in ('up', 'down')),
          created_at timestamptz not null default now()
        );
        create index pr_feedback_repository on pr_feedback (repository_id, advisory_id);
      `.execute(db);
      await sql`alter table pr_feedback enable row level security`.execute(db);
      await sql`alter table pr_feedback force row level security`.execute(db);
      await sql`create policy tenant_isolation on pr_feedback using (${tenantPredicate("account_id")}) with check (${tenantPredicate("account_id")})`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists pr_feedback`.execute(db);
    },
  },
  "0017_repository_committers": {
    async up(db: Kysely<unknown>) {
      // Per-committer billing (I-03): who committed to a private repository in the last 90 days, as hashes of their
      // GitHub login (or commit email when there is none), never the identities themselves.
      await sql`
        alter table repositories add column committers jsonb not null default '[]';
        alter table repositories add column committers_at timestamptz;
      `.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`alter table repositories drop column if exists committers, drop column if exists committers_at`.execute(db);
    },
  },
  "0018_sensor_tokens": {
    async up(db: Kysely<unknown>) {
      // The traffic sensor's upload token (F-01), one per account: the row holds its SHA-256, never the token.
      await sql`
        create table sensor_tokens (
          account_id bigint primary key references accounts on delete cascade,
          token_hash text not null unique,
          created_at timestamptz not null default now(),
          last_used_at timestamptz
        );
      `.execute(db);
      await sql`alter table sensor_tokens enable row level security`.execute(db);
      await sql`alter table sensor_tokens force row level security`.execute(db);
      await sql`create policy tenant_isolation on sensor_tokens using (${tenantPredicate("account_id")}) with check (${tenantPredicate("account_id")})`.execute(db);
    },
    async down(db: Kysely<unknown>) {
      await sql`drop table if exists sensor_tokens`.execute(db);
    },
  },
};

/**
 * How long a migration waits for a table lock before it fails (and the deploy with it), so an ALTER queued
 * behind a long transaction does not hold up every query on that table meanwhile.
 */
export const MIGRATION_LOCK_TIMEOUT = "10s";

/** Each migration first sets the lock timeout for its transaction. */
export function withLockTimeout(all: Record<string, Migration>, timeout = MIGRATION_LOCK_TIMEOUT): Record<string, Migration> {
  return Object.fromEntries(
    Object.entries(all).map(([name, m]) => [
      name,
      {
        async up(db: Kysely<unknown>) {
          await sql`select set_config('lock_timeout', ${timeout}, true)`.execute(db);
          await m.up(db);
        },
        ...(m.down ? { down: m.down } : {}),
      },
    ]),
  );
}

const provider: MigrationProvider = { getMigrations: async () => withLockTimeout(migrations) };

/** Apply every pending migration. Runs as the connecting (owner) user, not the app role. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
