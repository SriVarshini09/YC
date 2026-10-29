import type { Advisory, ChangeClass, LockedCallSite } from "@shapi/core";
import { Project, ScriptKind, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";

/** A text replacement in one file, in original-text offsets. */
export interface Edit {
  start: number;
  end: number;
  text: string;
  /**
   * One-line Markdown description for the PR body, for example "`src/deploy.ts:22` `res.status !== 204` → …".
   * Text from the repository (code, paths) goes in a codeSpan, so it cannot add Markdown of its own.
   */
  note: string;
}

/**
 * `text` as an inline code span: GitHub renders it literally, so Markdown or HTML in it makes no link,
 * image, @mention, issue reference or layout change. On one line, and at most `max` characters.
 */
export function codeSpan(text: string, max = 500): string {
  let flat = text.replace(/\s+/g, " ").trim();
  if (flat.length > max) flat = `${flat.slice(0, max - 1)}…`;
  const fence = "`".repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  return `${fence} ${flat} ${fence}`;
}

/** A note's "code → code", each side a code span. */
export const swap = (from: string, to: string) => `${codeSpan(from)} → ${codeSpan(to)}`;

export interface RecipeContext {
  sourceFile: SourceFile;
  call: CallExpression;
  callSite: LockedCallSite;
  advisory: Advisory;
}

/** A deterministic code transform for one change class. */
export interface Recipe {
  id: string;
  changeClass: ChangeClass;
  description: string;
  /** Edits that fix the call site; empty when the recipe finds nothing to change. */
  edits(ctx: RecipeContext): Edit[];
}

export interface FileChange {
  /** Repo-relative POSIX path. */
  file: string;
  before: string;
  after: string;
  notes: string[];
}

export type RecipeOutcome =
  | { status: "applied"; recipe: string; change: FileChange }
  | { status: "no-recipe" | "no-change" | "call-not-found"; recipe?: string; reason: string };

/**
 * Find the call expression the api.lock points at (1-based line and column of
 * the call's start). In `fetch(url).then(cb)` both calls start at `fetch`; the
 * call site is the innermost one.
 */
export function findCall(sf: SourceFile, site: Pick<LockedCallSite, "line" | "column">): CallExpression | undefined {
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => {
      const pos = sf.getLineAndColumnAtPos(c.getStart());
      return pos.line === site.line && pos.column === site.column;
    })
    .sort((a, b) => a.getWidth() - b.getWidth())[0];
}

/** Apply edits right to left so earlier offsets stay valid. */
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Run the advisory's recipe against the file holding `callSite`. `text` is the file's current content. */
export function runRecipe(recipes: Record<string, Recipe>, advisory: Advisory, callSite: LockedCallSite, text: string): RecipeOutcome {
  const recipe = advisory.recipeId ? recipes[advisory.recipeId] : undefined;
  if (!recipe) return { status: "no-recipe", reason: advisory.recipeId ? `unknown recipe ${advisory.recipeId}` : "advisory names no recipe" };

  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: true } });
  const kind = /\.(c|m)?jsx?$/.test(callSite.file) ? ScriptKind.JS : callSite.file.endsWith("x") ? ScriptKind.TSX : ScriptKind.TS;
  const sourceFile = project.createSourceFile(`/${callSite.file}`, text, { scriptKind: kind });
  const call = findCall(sourceFile, callSite);
  if (!call) return { status: "call-not-found", recipe: recipe.id, reason: `no call at ${callSite.file}:${callSite.line}:${callSite.column}` };

  const edits = recipe.edits({ sourceFile, call, callSite, advisory });
  if (edits.length === 0) return { status: "no-change", recipe: recipe.id, reason: "recipe found nothing to change" };
  return {
    status: "applied",
    recipe: recipe.id,
    change: { file: callSite.file, before: text, after: applyEdits(text, edits), notes: edits.map((e) => e.note) },
  };
}
