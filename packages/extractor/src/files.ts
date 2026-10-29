import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { providerForPackage, providerForPythonPackage } from "@shapi/core";

const SOURCE_FILE = /\.(c|m)?[jt]sx?$/;
const PYTHON_FILE = /\.py$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "bower_components", "venv", "__pycache__", "site-packages"]);
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
    const entries = readdirSync(dir, { withFileTypes: true });
    // Static files a framework serves as they are (Next.js, Vite, Laravel): public/ at the root or next to a package.json.
    // Elsewhere (src/public/, a Python package named public) it is source.
    const servesPublic = dir === root || entries.some((e) => e.isFile() && e.name === "package.json");
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !(entry.name === "public" && servesPublic)) walk(full);
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
      for (const name of pyprojectPackages(text)) names.add(name);
    }
    for (const name of [...names].sort()) {
      const provider = providerForPythonPackage(name);
      if (provider) found.push({ provider: provider.id, package: name, manifest: toPosix(path.relative(root, manifest)) });
    }
  }
  return found;
}

/**
 * pyproject.toml: "pkg>=1" items in a dependency list (`dependencies`, or a list under
 * [project.optional-dependencies] or [dependency-groups]), or pkg = "^1" in a Poetry [...dependencies] table.
 * Other lists (`keywords = [...]`) are not dependencies, and a bracket in quotes ("pkg[extra]") doesn't end a list.
 */
function pyprojectPackages(text: string): string[] {
  const names: string[] = [];
  let table = "";
  let depth = 0;
  for (const line of text.split(/\r?\n/)) {
    let t = line.replace(/#.*/, "").trim();
    if (depth === 0) {
      const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(t);
      if (header) {
        table = header[1]!;
        continue;
      }
      const kv = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*(.*)$/.exec(t);
      if (!kv) continue;
      const key = kv[1]!;
      const value = kv[2]!;
      if (!value.startsWith("[")) {
        if (/dependencies$/.test(table)) names.push(key);
        continue;
      }
      if (!/^(dependencies|optional-dependencies|dev-dependencies)$/.test(key) && !/(^|\.)(optional-dependencies|dependency-groups|dev-dependencies)$/.test(table)) continue;
      t = value;
    }
    // In a list: its quoted items, until the bracket that closes it.
    let quote = "";
    let item = "";
    for (const ch of t) {
      if (quote) {
        if (ch !== quote) item += ch;
        else {
          quote = "";
          const m = depth === 1 ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(item) : null;
          if (m) names.push(m[1]!);
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        item = "";
      } else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) break;
    }
  }
  return names;
}
