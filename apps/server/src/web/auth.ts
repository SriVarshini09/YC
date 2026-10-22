import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withService, type Db } from "@shapi/db";
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

export interface Session {
  login: string;
  githubUserId: string;
  installationIds: string[];
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
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export interface GitHubIdentity {
  id: string;
  login: string;
  /** Installations of this GitHub App the user can access. */
  installationIds: string[];
}

/**
 * Exchange the OAuth code for a user token, read who the user is and which installations of this
 * app they can access, then drop the token: SHAPI keeps no user credential.
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
  const installations = (await user.paginate("GET /user/installations", { per_page: 100 })) as { id: number }[];
  return { id: String(me.id), login: me.login, installationIds: installations.map((i) => String(i.id)) };
}

/** Start a session for a signed-in user; returns the cookie token. Only its hash is stored. */
export async function createSession(db: Db, identity: GitHubIdentity, now = new Date()): Promise<{ token: string; session: Session }> {
  const token = randomToken();
  const session: Session = {
    login: identity.login,
    githubUserId: identity.id,
    installationIds: identity.installationIds,
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
  return { login: row.login, githubUserId: row.github_user_id, installationIds: row.installation_ids, csrf: row.csrf, expiresAt: row.expires_at };
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
