import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { providerForPackage } from "@shapi/core";

const SOURCE_FILE = /\.(c|m)?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "bower_components"]);

export interface RepoFiles {
  sources: string[];
  manifests: string[];
}

/** Walk a repository for source files and package.json manifests, skipping dependencies and build output. */
export function listRepoFiles(root: string): RepoFiles {
  const sources: string[] = [];
  const manifests: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (entry.name === "package.json") manifests.push(full);
        else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) sources.push(full);
      }
    }
  };
  walk(root);
  return { sources: sources.sort(), manifests: manifests.sort() };
}

export interface DeclaredProvider {
  provider: string;
  package: string;
  manifest: string;
}

/** Providers whose SDKs are declared as dependencies in any package.json of the repo. */
export function declaredProviders(root: string, manifests: string[]): DeclaredProvider[] {
  const found: DeclaredProvider[] = [];
  for (const manifest of manifests) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[field];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
    }
    for (const name of [...names].sort()) {
      const provider = providerForPackage(name);
      if (provider) found.push({ provider: provider.id, package: name, manifest: toPosix(path.relative(root, manifest)) });
    }
  }
  return found;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
