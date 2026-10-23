import path from "node:path";
import { readFileSync } from "node:fs";
import { Project, ScriptKind } from "ts-morph";
import type { CallSite } from "@shapi/core";
import { extractFromFile, type FoundCall } from "./callsites";
import { addResponseSurface } from "./surface";
import { declaredProviders, declaredPythonProviders, listRepoFiles, toPosix, type DeclaredProvider } from "./files";
import { extractPython, pythonParserLoaded } from "./python";

export type { CallKind, CallSite, NameValue, Surface } from "@shapi/core";
export type { FoundCall } from "./callsites";
export { evalString, parseUrl } from "./callsites";
export type { DeclaredProvider } from "./files";
export { loadPythonParser, pythonParserLoaded } from "./python";

export interface ExtractResult {
  root: string;
  filesScanned: number;
  callSites: CallSite[];
  declared: DeclaredProvider[];
  /** TypeScript and JavaScript call sites with their AST nodes, for passes that need them. */
  found: FoundCall[];
  /** Files that were not scanned, with why (Python files before loadPythonParser(), files that fail to parse). */
  skipped: { file: string; reason: string }[];
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

/**
 * Find every third-party API call site under `rootDir`, in TypeScript, JavaScript and Python. Syntax only:
 * no type checking, no dependency resolution. Python needs `await loadPythonParser()` once beforehand.
 */
export function extractCallSites(rootDir: string): ExtractResult {
  const root = path.resolve(rootDir);
  const { sources, manifests, python, pythonManifests } = listRepoFiles(root);
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

  const skipped: ExtractResult["skipped"] = [];
  const pythonSites: CallSite[] = [];
  for (const abs of python) {
    const rel = toPosix(path.relative(root, abs));
    if (!pythonParserLoaded()) {
      skipped.push({ file: rel, reason: "the Python parser was not loaded" });
      continue;
    }
    try {
      pythonSites.push(...extractPython(readFileSync(abs, "utf8"), rel));
    } catch (err) {
      skipped.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const callSites = [...found.map((f) => f.site), ...pythonSites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return {
    root,
    filesScanned: sources.length + python.length - skipped.length,
    callSites,
    declared: [...declaredProviders(root, manifests), ...declaredPythonProviders(root, pythonManifests)],
    found,
    skipped,
  };
}
