import { Template, defaultBuildLogger } from "e2b";

/** The E2B template SHAPI runs repositories in. E2B's default image ships Node 20.9, too old for current vitest. */
export const SHAPI_TEMPLATE = "shapi-node22";

/** Official Node 22 image, with Corepack for pnpm and Yarn repositories, running as the unprivileged `user`. */
export function shapiTemplate() {
  return Template()
    .fromNodeImage("22")
    .setUser("root")
    .runCmd(["id -u user >/dev/null 2>&1 || useradd -m -s /bin/bash user", "corepack enable"])
    .setUser("user")
    .setWorkdir("/home/user");
}

/** Build (or rebuild) the template in the E2B account the key belongs to. Needed once per account. */
export async function buildShapiTemplate(apiKey: string) {
  return Template.build(shapiTemplate(), SHAPI_TEMPLATE, { apiKey, cpuCount: 2, memoryMB: 4096, onBuildLogs: defaultBuildLogger() });
}
