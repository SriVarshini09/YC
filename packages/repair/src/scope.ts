import type { LockedCallSite } from "@shapi/core";
import { Node, Project, ScriptKind } from "ts-morph";
import { changedRanges } from "./undo";

/**
 * The scope check (execution plan V-05): an LLM fix may only edit the function that makes the affected call. An edit
 * anywhere else (another file, a helper, module-level code) may be right, but nothing predicted it, so the PR opens as
 * a draft labelled needs-human. A deterministic recipe edits only what it names, so its changes are in scope.
 */
export interface ScopeCheck {
  status: "in-scope" | "out-of-scope";
  detail: string;
  /** Edits outside the predicted lines: `file` for another file, `file:line` for a line of the call site's file. */
  outside?: string[];
}

/** Without an enclosing function, the predicted lines are this many on each side of the call. */
const AROUND = 10;

export function checkScope(input: { callSite: LockedCallSite; method: "recipe" | "llm"; files: { file: string; before: string; after: string }[] }): ScopeCheck {
  const { callSite } = input;
  if (input.method === "recipe") return { status: "in-scope", detail: "a deterministic recipe edits only the code it names" };
  const own = input.files.find((f) => f.file === callSite.file);
  const span = own ? predictedSpan(callSite, own.before) : undefined;
  const outside: string[] = [];
  for (const f of input.files) {
    if (f.before === f.after) continue;
    if (f.file !== callSite.file || !span) {
      outside.push(f.file);
      continue;
    }
    for (const h of changedRanges(f.before, f.after)) {
      // Lines are 1-based in the span; an insertion (a0 === a1) sits between two lines.
      const first = h.a0 + 1;
      const last = Math.max(h.a1, h.a0 + 1);
      if (first < span.start || last > span.end) outside.push(`${f.file}:${first}`);
    }
  }
  if (!outside.length) return { status: "in-scope", detail: `every edit is inside ${span?.name ?? "the call's surroundings"} (lines ${span?.start}-${span?.end})` };
  return { status: "out-of-scope", outside, detail: `the change also edits ${outside.join(", ")}, outside ${span?.name ?? "the call's surroundings"} that makes the call` };
}

/** The lines of the function that contains the call site, or the lines around it at module level. */
function predictedSpan(callSite: LockedCallSite, text: string): { start: number; end: number; name: string } {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile(`/${callSite.file}`, text, { scriptKind: /\.(c|m)?jsx?$/.test(callSite.file) ? ScriptKind.JS : ScriptKind.TS });
  let fn: Node | undefined;
  sf.forEachDescendant((node) => {
    const isFn = Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isMethodDeclaration(node);
    // The outermost function around the call: the one the contract test calls, not a callback inside it.
    if (!fn && isFn && node.getStartLineNumber() <= callSite.line && node.getEndLineNumber() >= callSite.line) fn = node;
  });
  if (!fn) return { start: Math.max(1, callSite.line - AROUND), end: callSite.line + AROUND, name: "the lines around the call" };
  // A `const f = () => …` is predicted from its declaration line.
  const decl = Node.isVariableDeclaration(fn.getParent()) ? fn.getParent()!.getParent()!.getParent()! : fn;
  const named = Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getName() : Node.isVariableDeclaration(fn.getParent()) ? (fn.getParent() as Node & { getName(): string }).getName() : undefined;
  return { start: decl.getStartLineNumber(), end: fn.getEndLineNumber(), name: named ? `${named}()` : "the function" };
}
