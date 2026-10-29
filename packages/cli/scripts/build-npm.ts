// Builds the publishable `shapi-cli` package into packages/cli/npm:
//   node packages/cli/scripts/build-npm.ts
// SHAPI's own workspace packages are bundled in; only the third-party npm packages the bundle
// actually imports become dependencies. The reviewed advisories and the recordings ship inside.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(cliDir, "../..");
const out = path.join(cliDir, "npm");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const cliPkg = readJson(path.join(cliDir, "package.json"));
const license = readLicense();

// Every third-party dependency declared by the CLI and the workspace packages it pulls in.
const declared = new Map<string, string>();
for (const dir of readdirSync(path.join(root, "packages"))) {
  const pkgPath = path.join(root, "packages", dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  for (const [name, range] of Object.entries((readJson(pkgPath).dependencies ?? {}) as Record<string, string>)) {
    if (!name.startsWith("@shapi/") && name !== "shapi" && !declared.has(name)) declared.set(name, range);
  }
}

rmSync(out, { recursive: true, force: true });
await build({
  entry: { index: path.join(cliDir, "src/index.ts") },
  outDir: path.join(out, "dist"),
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: false,
  dts: false,
  clean: true,
  silent: true,
  noExternal: [/^@shapi\//],
  external: [...declared.keys()],
  tsconfig: path.join(root, "tsconfig.json"),
  metafile: true,
});

// Keep only the dependencies the bundle really imports, as the bundler recorded them.
const metafile = readJson(path.join(out, "dist", "metafile-esm.json")) as { outputs: Record<string, { imports: { path: string; external?: boolean }[] }> };
const imported = new Set<string>();
for (const output of Object.values(metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external || imp.path.startsWith("node:")) continue;
    imported.add(imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0]!);
  }
}
rmSync(path.join(out, "dist", "metafile-esm.json"));
// The Python grammar ships as a file next to the bundle, not as the tree-sitter-python package (whose
// install script builds a native binding the scanner never uses).
const extractorRequire = createRequire(path.join(root, "packages", "extractor", "package.json"));
copyFileSync(extractorRequire.resolve("tree-sitter-python/tree-sitter-python.wasm"), path.join(out, "dist", "tree-sitter-python.wasm"));
imported.delete("tree-sitter-python");
const unknown = [...imported].filter((d) => !declared.has(d) && !isBuiltin(d));
if (unknown.length) throw new Error(`bundle imports undeclared packages: ${unknown.join(", ")}`);
// `fix` runs contract tests with vitest when the repository has none; it is resolved at runtime, so the bundler cannot see it.
for (const runtime of ["vitest"]) imported.add(runtime);
const dependencies = Object.fromEntries([...imported].filter((d) => declared.has(d)).sort().map((d) => [d, declared.get(d)!]));

mkdirSync(path.join(out, "bin"), { recursive: true });
cpSync(path.join(cliDir, "bin/shapi.js"), path.join(out, "bin/shapi.js"));
mkdirSync(path.join(out, "advisories"), { recursive: true });
for (const f of readdirSync(path.join(root, "advisories")).filter((f) => f.endsWith(".json"))) cpSync(path.join(root, "advisories", f), path.join(out, "advisories", f));
cpSync(path.join(root, "fixtures/recordings"), path.join(out, "recordings"), { recursive: true });
cpSync(path.join(cliDir, "README.npm.md"), path.join(out, "README.md"));
cpSync(path.join(cliDir, "LICENSE"), path.join(out, "LICENSE"));

const pkg = {
  name: "shapi-cli",
  version: cliPkg.version,
  description: "Find the code that breaks when a third-party API changes, and fix it test-first.",
  keywords: ["api", "breaking-changes", "api-lock", "dependabot", "github", "stripe", "codemod", "contract-test"],
  type: "module",
  // Both names work after `npm install -g shapi-cli`; `npx shapi-cli` needs the package name. Never `npx shapi`:
  // that is someone else's package on npm.
  bin: { shapi: "bin/shapi.js", "shapi-cli": "bin/shapi.js" },
  files: ["bin", "dist", "advisories", "recordings", "README.md", "LICENSE"],
  engines: cliPkg.engines,
  license,
  homepage: "https://shapi.dev",
  // Bugs go to the public advisory repository, which takes issues.
  bugs: { url: "https://github.com/SriVarshini09/shapi-advisories/issues", email: "sri@shapi.dev" },
  dependencies,
};
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`built shapi-cli@${pkg.version} in ${path.relative(root, out)} (${Object.keys(dependencies).length} dependencies: ${Object.keys(dependencies).join(", ")})`);

/** The CLI package's own license (packages/cli/LICENSE); the rest of the repository is not covered by it. */
function readLicense(): string {
  const file = path.join(cliDir, "LICENSE");
  if (!existsSync(file)) throw new Error("packages/cli/LICENSE is missing: the package cannot be published without a license");
  const text = readFileSync(file, "utf8");
  if (/Apache License\s+Version 2\.0/.test(text)) return "Apache-2.0";
  if (/^MIT License/m.test(text)) return "MIT";
  throw new Error("LICENSE is neither Apache-2.0 nor MIT: set the license field by hand");
}

function isBuiltin(name: string): boolean {
  return ["fs", "path", "url", "os", "crypto", "child_process", "module", "util", "events", "stream", "http", "https", "net", "zlib", "assert", "worker_threads", "readline", "process", "buffer", "tty"].includes(name);
}
