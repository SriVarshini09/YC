import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withService, withTenant, type Db } from "@shapi/db";
import { createOctokit } from "@shapi/github-app";

export const SESSION_COOKIE = "shapi_session";
export const STATE_COOKIE = "shapi_oauth_state";
/** Matches the lifetime of a GitHub App user token: sign in again to pick up new installations. */
export const SESSION_HOURS = 8;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public base URL of the web app, for example https://app.shapi.dev (no trailing slash). */
  publicUrl: string;
}

/** What the user may do in one installation, read from GitHub at sign-in. Repository ids are GitHub's. */
export interface InstallationAccess {
  /** Repositories the user can open on GitHub, can push to, and administers. */
  read: string[];
  push: string[];
  admin: string[];
  /** The installation is on the user's own personal account. */
  owner: boolean;
}

export interface Session {
  login: string;
  githubUserId: string;
  installationIds: string[];
  /** Per installation id. */
  access: Record<string, InstallationAccess>;
  csrf: string;
  expiresAt: Date;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export function redirectUri(config: OAuthConfig): string {
  return `${config.publicUrl}/auth/github/callback`;
}

export function authorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("state", state);
  // GitHub Apps ignore scopes: the user token can do only what both the app and the user can.
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

export function sameToken(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  // Compare bytes: a string of the same length can be longer in UTF-8, and timingSafeEqual throws on unequal lengths.
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface GitHubIdentity {
  id: string;
  login: string;
  /** Installations of this GitHub App the user can access. */
  installationIds: string[];
  /** Per installation id: the repositories the user can read, push to and administer. */
  access: Record<string, InstallationAccess>;
}

interface UserInstallation {
  id: number;
  account?: { id: number; type?: string } | null;
}

interface UserRepository {
  id: number;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

/**
 * Exchange the OAuth code for a user token, read who the user is, which installations of this app they
 * can access and, in each, which repositories they can read, push to and administer. Then drop the
 * token: SHAPI keeps no user credential. GitHub lists an installation to anyone with access to one of
 * its repositories, so the repository list is what limits what the user sees.
 */
export async function identify(config: OAuthConfig, code: string, opts: { fetch?: typeof globalThis.fetch } = {}): Promise<GitHubIdentity> {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri(config) }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!body.access_token) throw new Error(`GitHub sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  const user = createOctokit({ auth: body.access_token }, { fetch: opts.fetch, resilient: false });
  const { data: me } = await user.rest.users.getAuthenticated();
  const installations = (await user.paginate("GET /user/installations", { per_page: 100 })) as UserInstallation[];
  const access: Record<string, InstallationAccess> = {};
  for (const i of installations) {
    const repos = (await user.paginate("GET /user/installations/{installation_id}/repositories", { installation_id: i.id, per_page: 100 })) as UserRepository[];
    const ids = (keep: (p: NonNullable<UserRepository["permissions"]>) => boolean | undefined) => repos.filter((r) => r.permissions && keep(r.permissions)).map((r) => String(r.id));
    access[String(i.id)] = {
      read: repos.map((r) => String(r.id)),
      push: ids((p) => p.push || p.maintain || p.admin),
      admin: ids((p) => p.admin),
      owner: i.account?.type === "User" && String(i.account.id) === String(me.id),
    };
  }
  return { id: String(me.id), login: me.login, installationIds: installations.map((i) => String(i.id)), access };
}

/** Start a session for a signed-in user; returns the cookie token. Only its hash is stored. */
export async function createSession(db: Db, identity: GitHubIdentity, now = new Date()): Promise<{ token: string; session: Session }> {
  const token = randomToken();
  const session: Session = {
    login: identity.login,
    githubUserId: identity.id,
    installationIds: identity.installationIds,
    access: identity.access,
    csrf: randomToken(),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000),
  };
  await withService(db, async (tx) => {
    await tx.deleteFrom("sessions").where("expires_at", "<", now).execute();
    await tx
      .insertInto("sessions")
      .values({
        token_hash: hash(token),
        github_user_id: session.githubUserId,
        login: session.login,
        installation_ids: JSON.stringify(session.installationIds),
        access: JSON.stringify(session.access),
        csrf: session.csrf,
        expires_at: session.expiresAt,
      })
      .execute();
  });
  return { token, session };
}

export async function loadSession(db: Db, token: string | undefined, now = new Date()): Promise<Session | undefined> {
  if (!token) return undefined;
  const row = await withService(db, (tx) => tx.selectFrom("sessions").selectAll().where("token_hash", "=", hash(token)).where("expires_at", ">", now).executeTakeFirst());
  if (!row) return undefined;
  return { login: row.login, githubUserId: row.github_user_id, installationIds: row.installation_ids, access: row.access, csrf: row.csrf, expiresAt: row.expires_at };
}

export async function endSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await withService(db, (tx) => tx.deleteFrom("sessions").where("token_hash", "=", hash(token)).execute());
}

/** The SHAPI accounts a session may open: installations it can access that SHAPI knows. */
export async function sessionAccounts(db: Db, session: Session) {
  if (!session.installationIds.length) return [];
  return withService(db, (tx) =>
    tx
      .selectFrom("accounts")
      .select(["id", "login", "type", "suspended_at", "github_installation_id"])
      .where("github_installation_id", "in", session.installationIds)
      .orderBy("login")
      .execute(),
  );
}

/** What a session may do in one SHAPI account. Repository ids are GitHub's. */
export interface AccountAccess {
  /** Repositories the user can open on GitHub: the only ones the account pages show. */
  read: string[];
  /** Repositories the user can push to: they may pause and resume SHAPI there. */
  push: string[];
  /** May change the account's settings and billing. */
  admin: boolean;
}

/**
 * The session's rights in an account. Settings and billing act on every repository, so they need an
 * account admin: the owner of a personal account, or for an organization a user who is admin on every
 * repository SHAPI covers there (organization owners are).
 */
export async function accountAccess(db: Db, session: Session, account: { id: string; type: string; github_installation_id: string | null }): Promise<AccountAccess> {
  const access = session.access[String(account.github_installation_id)];
  if (!access) return { read: [], push: [], admin: false };
  if (account.type === "User") return { read: access.read, push: access.push, admin: access.owner };
  // No repository yet proves nothing: GitHub lists an installation to anyone with access to one of its repositories.
  const covered = await withTenant(db, account.id, (tx) => tx.selectFrom("repositories").select("github_repo_id").execute());
  const mine = new Set(access.admin);
  return { read: access.read, push: access.push, admin: covered.length > 0 && covered.every((r) => mine.has(String(r.github_repo_id))) };
}
