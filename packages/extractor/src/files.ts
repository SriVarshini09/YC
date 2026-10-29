import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { providerForPackage, providerForPythonPackage } from "@shapi/core";

const SOURCE_FILE = /\.(c|m)?[jt]sx?$/;
const PYTHON_FILE = /\.py$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "bower_components", "venv", "__pycache__", "site-packages", "public"]);
/** Minified and bundled output committed next to the source: app.min.js, vendor.bundle.js. */
const BUNDLE_FILE = /\.(min|bundle)\.(c|m)?js$/;
/** Python dependency manifests: requirements*.txt and pyproject.toml. */
const PYTHON_MANIFEST = /^(requirements[\w.-]*\.txt|pyproject\.toml)$/;

export interface RepoFiles {
  sources: string[];
  manifests: string[];
  python: string[];
  pythonManifests: string[];
}

/** Walk a repository for source files and package.json manifests, skipping dependencies and build output. */
export function listRepoFiles(root: string): RepoFiles {
  const sources: string[] = [];
  const manifests: string[] = [];
  const python: string[] = [];
  const pythonManifests: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (entry.name === "package.json") manifests.push(full);
        else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts") && !BUNDLE_FILE.test(entry.name)) sources.push(full);
        else if (PYTHON_FILE.test(entry.name)) python.push(full);
        else if (PYTHON_MANIFEST.test(entry.name)) pythonManifests.push(full);
      }
    }
  };
  walk(root);
  return { sources: sources.sort(), manifests: manifests.sort(), python: python.sort(), pythonManifests: pythonManifests.sort() };
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

/** Providers whose Python SDKs are declared in requirements*.txt or pyproject.toml. */
export function declaredPythonProviders(root: string, manifests: string[]): DeclaredProvider[] {
  const found: DeclaredProvider[] = [];
  for (const manifest of manifests) {
    let text: string;
    try {
      text = readFileSync(manifest, "utf8");
    } catch {
      continue;
    }
    const names = new Set<string>();
    if (manifest.endsWith(".txt")) {
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ""));
        if (m && !line.trim().startsWith("-")) names.add(m[1]!);
      }
    } else {
      // pyproject.toml: "pkg>=1" items in a dependencies list, or pkg = "^1" in a [...dependencies] table
      let inTable = false;
      let inList = false;
      for (const line of text.split(/\r?\n/)) {
        const t = line.replace(/#.*/, "").trim();
        if (/^\[/.test(t)) {
          inTable = /dependencies\]$/.test(t);
          inList = false;
          continue;
        }
        if (/^(dependencies|optional-dependencies|dev-dependencies)\s*=\s*\[/.test(t) || /^[\w-]+\s*=\s*\[/.test(t)) inList = true;
        if (inList) for (const m of t.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(m[1]!);
        if (inList && t.includes("]")) inList = false;
        const kv = inTable ? /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(t) : null;
        if (kv) names.add(kv[1]!);
      }
    }
    for (const name of [...names].sort()) {
      const provider = providerForPythonPackage(name);
      if (provider) found.push({ provider: provider.id, package: name, manifest: toPosix(path.relative(root, manifest)) });
    }
  }
  return found;
}
