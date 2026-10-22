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
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

/** Apply every pending migration. Runs as the connecting (owner) user, not the app role. */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<string[]> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
