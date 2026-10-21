import path from "node:path";
import { readFileSync } from "node:fs";
import { Project, ScriptKind } from "ts-morph";
import type { CallSite } from "@shapi/core";
import { extractFromFile, type FoundCall } from "./callsites";
import { addResponseSurface } from "./surface";
import { declaredProviders, listRepoFiles, toPosix, type DeclaredProvider } from "./files";

export type { CallKind, CallSite, NameValue, Surface } from "@shapi/core";
export type { FoundCall } from "./callsites";
export { evalString, parseUrl } from "./callsites";
export type { DeclaredProvider } from "./files";

export interface ExtractResult {
  root: string;
  filesScanned: number;
  callSites: CallSite[];
  declared: DeclaredProvider[];
  /** Call sites with their AST nodes, for passes that need them. */
  found: FoundCall[];
}

const SCRIPT_KINDS: Record<string, ScriptKind> = {
  ".ts": ScriptKind.TS,
  ".mts": ScriptKind.TS,
  ".cts": ScriptKind.TS,
  ".tsx": ScriptKind.TSX,
  ".js": ScriptKind.JS,
  ".mjs": ScriptKind.JS,
  ".cjs": ScriptKind.JS,
  ".jsx": ScriptKind.JSX,
};

/** Find every third-party API call site under `rootDir`. Syntax only: no type checking, no dependency resolution. */
export function extractCallSites(rootDir: string): ExtractResult {
  const root = path.resolve(rootDir);
  const { sources, manifests } = listRepoFiles(root);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });

  const found: FoundCall[] = [];
  for (const abs of sources) {
    const rel = toPosix(path.relative(root, abs));
    const sf = project.createSourceFile(`/${rel}`, readFileSync(abs, "utf8"), {
      overwrite: true,
      scriptKind: SCRIPT_KINDS[path.extname(abs)] ?? ScriptKind.TS,
    });
    for (const f of extractFromFile(sf, rel)) {
      addResponseSurface(f);
      found.push(f);
    }
  }
  found.sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column);

  return {
    root,
    filesScanned: sources.length,
    callSites: found.map((f) => f.site),
    declared: declaredProviders(root, manifests),
    found,
  };
}
