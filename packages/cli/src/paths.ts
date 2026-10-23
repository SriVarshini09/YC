import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A data folder shipped with SHAPI. In the published `shapi-cli` package it sits next to `dist/`;
 * in the monorepo it is at the repository root. The first that exists wins.
 */
export function bundledDir(published: string, monorepo: string): string {
  const candidates = [new URL(`../${published}`, import.meta.url), new URL(`../../../${monorepo}`, import.meta.url)].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1]!;
}
