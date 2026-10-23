import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import type { Octokit } from "@octokit/rest";
import { createOctokit, type ClientOptions } from "./client";

/** The registered SHAPI GitHub App: its id and private key (PEM). */
export interface AppCredentials {
  appId: string;
  privateKey: string;
}

/**
 * Everything SHAPI asks an installer for, and nothing more. `contents: write` is needed to push
 * fix branches (it cannot touch workflow files); issues hold the per-repo dashboard.
 */
export const APP_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "write",
  issues: "write",
} as const;

/** Webhook events beyond installation events, which every app receives. */
export const APP_EVENTS = ["push", "pull_request", "issues"] as const;

/** Read-only token permissions for scanning a repo: the least a scan job needs. */
export const SCAN_PERMISSIONS = { metadata: "read", contents: "read" } as const;

type Permissions = Record<string, "read" | "write">;

/** Keys from env vars often arrive with literal "\n"; turn them back into a PEM. */
export function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/** Authenticated as the app itself (a JWT): for /app endpoints such as installations and webhook deliveries. */
export function appOctokit(creds: AppCredentials, opts: ClientOptions = {}): Octokit {
  return createOctokit({ authStrategy: createAppAuth, auth: { appId: creds.appId, privateKey: normalizePrivateKey(creds.privateKey) } }, opts);
}

/** Authenticated as one installation; the token is created on first use and refreshed before it expires. */
export function installationOctokit(creds: AppCredentials, installationId: number | string, opts: ClientOptions = {}): Octokit {
  return createOctokit(
    { authStrategy: createAppAuth, auth: { appId: creds.appId, privateKey: normalizePrivateKey(creds.privateKey), installationId: Number(installationId) } },
    opts,
  );
}

export interface ScopedToken {
  token: string;
  expiresAt: string;
}

/**
 * A short-lived installation token narrowed to some repositories and permissions, for handing to a
 * job (for example a sandboxed scan gets `SCAN_PERMISSIONS` on one repo). GitHub refuses anything
 * the installation itself was not granted.
 */
export async function scopedInstallationToken(
  creds: AppCredentials,
  installationId: number | string,
  scope: { repositoryIds?: number[]; permissions?: Permissions },
  opts: ClientOptions = {},
): Promise<ScopedToken> {
  const auth = (await appOctokit(creds, opts).auth({
    type: "installation",
    installationId: Number(installationId),
    repositoryIds: scope.repositoryIds,
    permissions: scope.permissions,
  })) as { token: string; expiresAt: string };
  return { token: auth.token, expiresAt: auth.expiresAt };
}

/** Repositories an installation can see, with full details (default branch, visibility). */
export interface InstallationRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived?: boolean;
}

export async function listInstallationRepositories(octokit: Octokit): Promise<InstallationRepository[]> {
  return (await octokit.paginate("GET /installation/repositories", { per_page: 100 })) as InstallationRepository[];
}

export function signWebhook(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Check `X-Hub-Signature-256` against the raw request body, in constant time. */
export function verifyWebhookSignature(secret: string, body: string | Buffer, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(signWebhook(secret, body));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ManifestInput {
  name: string;
  /** Homepage shown on the app's page. */
  url: string;
  webhookUrl: string;
  /** Where GitHub sends the browser back with a one-time code after the app is created. */
  redirectUrl: string;
  /** Public apps can be installed by anyone; private ones only by the owner. */
  public: boolean;
  /** Where GitHub sends users back after signing in to the web app (`/auth/github/callback`). */
  callbackUrls?: string[];
}

/** A GitHub App manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function appManifest(input: ManifestInput) {
  return {
    name: input.name,
    url: input.url,
    description: "Finds code that breaks when a third-party API changes, and opens verified fix pull requests.",
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.redirectUrl,
    ...(input.callbackUrls?.length ? { callback_urls: input.callbackUrls } : {}),
    public: input.public,
    default_permissions: APP_PERMISSIONS,
    default_events: [...APP_EVENTS],
  };
}

/** What GitHub returns once for a new app. `pem`, `webhook_secret` and `client_secret` are secrets. */
export interface RegisteredApp {
  id: number;
  slug: string;
  html_url: string;
  owner: { login: string } | null;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

/** Exchange the manifest flow's one-time code (valid for one hour) for the new app's credentials. */
export async function convertManifestCode(code: string, opts: ClientOptions = {}): Promise<RegisteredApp> {
  const octokit = createOctokit({}, opts);
  const { data } = await octokit.request("POST /app-manifests/{code}/conversions", { code });
  return data as unknown as RegisteredApp;
}
