import { e2bProvider } from "./e2b";
import { localProvider } from "./local";
import type { SandboxProvider } from "./types";

export * from "./types";
export * from "./snapshot";
export { e2bProvider, shellQuote, type E2BProviderOptions } from "./e2b";
export { localProvider } from "./local";
export { SHAPI_TEMPLATE, buildShapiTemplate, shapiTemplate } from "./template";

/**
 * The sandbox provider from the environment: SHAPI_SANDBOX=e2b (needs E2B_API_KEY) or local.
 * Production only ever runs customer code in E2B; asking for local there is an error.
 */
export function sandboxFromEnv(env: Record<string, string | undefined> = process.env): SandboxProvider {
  const kind = env.SHAPI_SANDBOX ?? (env.E2B_API_KEY ? "e2b" : "local");
  if (kind === "e2b") {
    if (!env.E2B_API_KEY) throw new Error("SHAPI_SANDBOX=e2b needs E2B_API_KEY");
    return e2bProvider({ apiKey: env.E2B_API_KEY, template: env.SHAPI_E2B_TEMPLATE });
  }
  if (kind !== "local") throw new Error(`unknown SHAPI_SANDBOX ${kind} (use e2b or local)`);
  if (env.NODE_ENV === "production") throw new Error("the local sandbox is not isolated and is refused in production; set E2B_API_KEY");
  return localProvider();
}
