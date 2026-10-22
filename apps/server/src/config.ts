import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repo-level advisories folder: apps/server/{src,dist}/ → ../../../advisories. Overridden in the container. */
const DEFAULT_ADVISORIES = fileURLToPath(new URL("../../../advisories", import.meta.url));

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
  /** Cron for the canary run; empty disables it. Default: every hour at minute 7. */
  CANARY_CRON: z.string().default("7 * * * *"),
  /** Comma-separated providers the canary runs (default: all with credentials). */
  CANARY_PROVIDERS: z.string().optional(),
  GIT_SHA: z.string().default("dev"),
});

export type Config = z.infer<typeof ConfigSchema> & { canaryProviders?: string[] };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  const c = parsed.data;
  if (c.NODE_ENV === "production" && !c.SHAPI_SHAPE_SECRET) throw new Error("SHAPI_SHAPE_SECRET is required in production");
  return { ...c, canaryProviders: c.CANARY_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean) };
}
