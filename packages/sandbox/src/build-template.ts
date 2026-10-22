// pnpm --filter @shapi/sandbox build-template
// Builds SHAPI's E2B template in your E2B account. Reads E2B_API_KEY from the environment or .shapi/e2b.env.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SHAPI_TEMPLATE, buildShapiTemplate } from "./template";

const envFile = fileURLToPath(new URL("../../../.shapi/e2b.env", import.meta.url));
if (!process.env.E2B_API_KEY && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.E2B_API_KEY) throw new Error("set E2B_API_KEY (or save it in .shapi/e2b.env)");
const info = await buildShapiTemplate(process.env.E2B_API_KEY);
console.log(`built E2B template ${SHAPI_TEMPLATE} (id ${info.templateId}, build ${info.buildId})`);
