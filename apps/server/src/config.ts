import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { DocsSite } from "./docs";

/** Repo-level advisories folder: apps/server/{src,dist}/ → ../../../advisories. Overridden in the container. */
const DEFAULT_ADVISORIES = fileURLToPath(new URL("../../../advisories", import.meta.url));
/** Recorded before/after responses shipped with SHAPI, used when the canary has none for an endpoint. */
const DEFAULT_RECORDINGS = fileURLToPath(new URL("../../../fixtures/recordings", import.meta.url));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string({ error: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SENTRY_DSN: z.string().optional(),
  /** Secret behind per-provider shape salts. Required in production so shapes are not hashed with a public value. */
  SHAPI_SHAPE_SECRET: z.string().optional(),
  SHAPI_ADVISORIES: z.string().default(DEFAULT_ADVISORIES),
  /** Public advisory repository (owner/name) to sync from instead of the local folder, for example SriVarshini09/shapi-advisories. */
  SHAPI_ADVISORIES_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name").optional(),
  /** Cron for syncing the advisory repository (only when SHAPI_ADVISORIES_REPO is set). Default: hourly at minute 41. */
  ADVISORIES_SYNC_CRON: z.string().default("41 * * * *"),
  /** Cron for the canary run; empty disables it. Default: every hour at minute 7. */
  CANARY_CRON: z.string().default("7 * * * *"),
  /** Comma-separated providers the canary runs (default: all with credentials). */
  CANARY_PROVIDERS: z.string().optional(),
  GIT_SHA: z.string().default("dev"),
  /** The docs site's public URL (https://shapi.dev): requests for its host are served from SHAPI_DOCS_DIR. Both or neither. */
  SHAPI_DOCS_URL: z.string().url().optional(),
  /** The docs build (site/.vitepress/dist); the container ships it at /app/docs. */
  SHAPI_DOCS_DIR: z.string().optional(),
  /** Claude fixes for accounts that opt in; unset, the option is hidden and only recipes fix code. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** The GitHub App (all three, or none: the webhook route answers 503 until they are set). */
  SHAPI_GITHUB_APP_ID: z.string().optional(),
  SHAPI_GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  SHAPI_GITHUB_WEBHOOK_SECRET: z.string().optional(),
  /** Cron for the webhook sweeper (re-queue and redeliver missed deliveries, prune old ones). */
  WEBHOOK_SWEEP_CRON: z.string().default("*/10 * * * *"),
  /** Days to keep processed webhook payloads. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  /** Days of repeated canary observations to keep (the newest observation of every distinct shape is always kept). */
  OBSERVATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SHAPI_RECORDINGS: z.string().default(DEFAULT_RECORDINGS),
  /** Cron for re-matching stored api.locks against the advisory database (it also runs after every advisory sync). */
  FANOUT_CRON: z.string().default("17 3 * * *"),
  /** Web sign-in: the GitHub App's OAuth client, the public URL GitHub redirects back to, and the cookie signing secret. */
  SHAPI_GITHUB_CLIENT_ID: z.string().optional(),
  SHAPI_GITHUB_CLIENT_SECRET: z.string().optional(),
  SHAPI_GITHUB_APP_SLUG: z.string().optional(),
  SHAPI_PUBLIC_URL: z.string().default("http://localhost:8080"),
  SHAPI_SESSION_SECRET: z.string().optional(),
  /** Stripe billing (all three, or none: without them every repository is covered). The price is created in Stripe. */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID: z.string().optional(),
});

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export interface WebAppConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  sessionSecret: string;
  appSlug?: string;
}

export interface BillingSettings {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  publicUrl: string;
}

export type Config = z.infer<typeof ConfigSchema> & { canaryProviders?: string[]; githubApp?: GitHubAppConfig; webApp?: WebAppConfig; billing?: BillingSettings; docs?: DocsSite };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  if (c.NODE_ENV === "production" && !c.SHAPI_SHAPE_SECRET) throw new Error("SHAPI_SHAPE_SECRET is required in production");
  const app = [c.SHAPI_GITHUB_APP_ID, c.SHAPI_GITHUB_APP_PRIVATE_KEY, c.SHAPI_GITHUB_WEBHOOK_SECRET];
  if (app.some(Boolean) && !app.every(Boolean)) {
    throw new Error("set all of SHAPI_GITHUB_APP_ID, SHAPI_GITHUB_APP_PRIVATE_KEY and SHAPI_GITHUB_WEBHOOK_SECRET, or none");
  }
  const githubApp = c.SHAPI_GITHUB_APP_ID
    ? { appId: c.SHAPI_GITHUB_APP_ID, privateKey: c.SHAPI_GITHUB_APP_PRIVATE_KEY!, webhookSecret: c.SHAPI_GITHUB_WEBHOOK_SECRET! }
    : undefined;
  let webApp: WebAppConfig | undefined;
  if (c.SHAPI_GITHUB_CLIENT_ID && c.SHAPI_GITHUB_CLIENT_SECRET) {
    if (c.NODE_ENV === "production" && (!c.SHAPI_SESSION_SECRET || c.SHAPI_SESSION_SECRET.length < 32)) {
      throw new Error("SHAPI_SESSION_SECRET (32+ characters) is required in production when web sign-in is configured");
    }
    webApp = {
      clientId: c.SHAPI_GITHUB_CLIENT_ID,
      clientSecret: c.SHAPI_GITHUB_CLIENT_SECRET,
      publicUrl: c.SHAPI_PUBLIC_URL.replace(/\/+$/, ""),
      // Development without a secret: sessions do not survive a restart, which is fine locally.
      sessionSecret: c.SHAPI_SESSION_SECRET ?? randomBytes(32).toString("hex"),
      appSlug: c.SHAPI_GITHUB_APP_SLUG,
    };
  }
  const stripe = [c.STRIPE_SECRET_KEY, c.STRIPE_WEBHOOK_SECRET, c.STRIPE_PRICE_ID];
  if (stripe.some(Boolean) && !stripe.every(Boolean)) throw new Error("set all of STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID, or none");
  if (c.NODE_ENV !== "production" && c.STRIPE_SECRET_KEY?.startsWith("sk_live_")) throw new Error("a live Stripe key outside production: use a test key (sk_test_)");
  const billing = c.STRIPE_SECRET_KEY
    ? { secretKey: c.STRIPE_SECRET_KEY, webhookSecret: c.STRIPE_WEBHOOK_SECRET!, priceId: c.STRIPE_PRICE_ID!, publicUrl: c.SHAPI_PUBLIC_URL.replace(/\/+$/, "") }
    : undefined;
  if (Boolean(c.SHAPI_DOCS_URL) !== Boolean(c.SHAPI_DOCS_DIR)) throw new Error("set both SHAPI_DOCS_URL and SHAPI_DOCS_DIR, or neither");
  const docs = c.SHAPI_DOCS_URL && c.SHAPI_DOCS_DIR ? { url: c.SHAPI_DOCS_URL, dir: c.SHAPI_DOCS_DIR } : undefined;
  return { ...c, canaryProviders: c.CANARY_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean), githubApp, webApp, billing, docs };
}
