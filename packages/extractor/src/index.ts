import path from "node:path";
import { readFileSync } from "node:fs";
import { Project, ScriptKind, type SourceFile } from "ts-morph";
import { GENERATED_TEST_HEADER, PYTHON_GENERATED_TEST_HEADER, type CallSite } from "@shapi/core";
import { extractFromFile, looseUrlSites, type FoundCall } from "./callsites";
import { addResponseSurface } from "./surface";
import { declaredProviders, declaredPythonProviders, listRepoFiles, toPosix, type DeclaredProvider } from "./files";
import { extractGo, goParserLoaded } from "./go";
import { extractPython, pythonParserLoaded } from "./python";

export type { CallKind, CallSite, NameValue, Surface } from "@shapi/core";
export type { FoundCall } from "./callsites";
export { evalString, parseUrl } from "./callsites";
export type { DeclaredProvider, RepoFiles } from "./files";
export { listRepoFiles, toPosix } from "./files";
export { goParserLoaded, loadGoParser } from "./go";
export { loadPythonParser, parsePython, pythonParserLoaded, type PyNode, type PyTree } from "./python";

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
 * Find every third-party API call site under `rootDir`, in TypeScript, JavaScript, Python and Go. Syntax only:
 * no type checking, no dependency resolution. Python needs `await loadPythonParser()` once beforehand, Go `await loadGoParser()`.
 */
export function extractCallSites(rootDir: string): ExtractResult {
  const root = path.resolve(rootDir);
  const { sources, manifests, python, pythonManifests, go } = listRepoFiles(root);
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });

  const found: FoundCall[] = [];
  const loose: CallSite[] = [];
  const skipped: ExtractResult["skipped"] = [];
  const failed = (rel: string, err: unknown) => skipped.push({ file: rel, reason: err instanceof Error ? err.message : String(err) });
  // Every file first, so a client imported from another file can be followed to where it is constructed.
  const files: { rel: string; sf: SourceFile }[] = [];
  // SHAPI's own contract tests name the old request on purpose: they are not call sites.
  let generated = 0;
  for (const abs of sources) {
    const rel = toPosix(path.relative(root, abs));
    try {
      const text = readFileSync(abs, "utf8");
      if (text.replace(/^\uFEFF/, "").startsWith(GENERATED_TEST_HEADER)) {
        generated++;
        continue;
      }
      const sf = project.createSourceFile(`/${rel}`, text, {
        overwrite: true,
        scriptKind: SCRIPT_KINDS[path.extname(abs)] ?? ScriptKind.TS,
      });
      files.push({ rel, sf });
    } catch (err) {
      failed(rel, err);
    }
  }
  // A file the extractor fails on is listed as skipped instead of failing the whole scan.
  for (const { rel, sf } of files) {
    try {
      const inFile = extractFromFile(sf, rel);
      for (const f of inFile) addResponseSurface(f);
      const looseInFile = looseUrlSites(sf, rel, inFile);
      found.push(...inFile);
      loose.push(...looseInFile);
    } catch (err) {
      failed(rel, err);
    }
  }
  found.sort((a, b) => a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column);

  const pythonSites: CallSite[] = [];
  for (const abs of python) {
    const rel = toPosix(path.relative(root, abs));
    if (!pythonParserLoaded()) {
      skipped.push({ file: rel, reason: "the Python parser was not loaded" });
      continue;
    }
    try {
      const text = readFileSync(abs, "utf8");
      if (text.replace(/^\uFEFF/, "").startsWith(PYTHON_GENERATED_TEST_HEADER)) {
        generated++;
        continue;
      }
      pythonSites.push(...extractPython(text, rel));
    } catch (err) {
      failed(rel, err);
    }
  }
  const goSites: CallSite[] = [];
  for (const abs of go) {
    const rel = toPosix(path.relative(root, abs));
    if (!goParserLoaded()) {
      skipped.push({ file: rel, reason: "the Go parser was not loaded" });
      continue;
    }
    try {
      goSites.push(...extractGo(readFileSync(abs, "utf8"), rel));
    } catch (err) {
      failed(rel, err);
    }
  }
  const callSites = [...found.map((f) => f.site), ...loose, ...pythonSites, ...goSites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return {
    root,
    filesScanned: sources.length - generated + python.length + go.length - skipped.length,
    callSites,
    declared: [...declaredProviders(root, manifests), ...declaredPythonProviders(root, pythonManifests)],
    found,
    skipped,
  };
}
