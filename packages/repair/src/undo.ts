import { testsRan } from "./runner";
import type { Workspace } from "./workspace";

/**
 * The undo check (execution plan V-04): after a fix passes, undo each part of it on its own and run the contract
 * test again. Every undo must make the test fail; a part whose undo the test survives is not what the test checks,
 * so a person has to look at it (the PR is labelled needs-human). The fix itself is kept either way.
 */
export interface UndoCheck {
  status: "passed" | "survived" | "not-run";
  /** Parts whose undo made the test fail. */
  killed: number;
  /** Parts of the change that were undone. */
  total: number;
  detail: string;
  /** Where the parts the test survived start: `file:line`. */
  survived?: string[];
}

/** More parts than this are not undone one by one: each needs another test run. */
export const MAX_UNDO_PARTS = 6;

interface Part {
  file: string;
  /** The file with only this part undone. */
  content: string;
  /** 1-based line in the fixed file where the part starts. */
  line: number;
}

export async function checkUndo(ws: Workspace, testFile: string, files: { file: string; before: string; after: string }[], maxParts = MAX_UNDO_PARTS): Promise<UndoCheck> {
  const parts = files.filter((f) => f.before !== "" && f.before !== f.after).flatMap((f) => partsOf(f.file, f.before, f.after));
  if (!parts.length) return { status: "not-run", killed: 0, total: 0, detail: "no part of an existing file to undo" };
  if (parts.length > maxParts) return { status: "not-run", killed: 0, total: parts.length, detail: `the change has ${parts.length} parts; SHAPI undoes up to ${maxParts}` };

  const fixed = new Map(files.map((f) => [f.file, f.after]));
  let killed = 0;
  const survived: string[] = [];
  for (const part of parts) {
    await ws.write(part.file, part.content);
    try {
      const run = await ws.runTest(testFile);
      if (!run.passed && !testsRan(run.output)) return { status: "not-run", killed, total: parts.length, detail: "the contract test did not run with a part undone" };
      if (run.passed) survived.push(`${part.file}:${part.line}`);
      else killed++;
    } finally {
      await ws.write(part.file, fixed.get(part.file)!);
    }
  }
  return survived.length
    ? { status: "survived", killed, total: parts.length, survived, detail: `undoing ${survived.join(", ")} does not make the contract test fail` }
    : { status: "passed", killed, total: parts.length, detail: "undoing any part of the change makes the contract test fail" };
}

/** The changed regions between two versions of a file, each as the fixed file with only that region undone. */
export function partsOf(file: string, before: string, after: string): Part[] {
  const a = before.split("\n");
  const b = after.split("\n");
  return hunks(a, b).map((h) => ({
    file,
    line: h.b0 + 1,
    content: [...b.slice(0, h.b0), ...a.slice(h.a0, h.a1), ...b.slice(h.b1)].join("\n"),
  }));
}

interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Changed line ranges, from the longest common subsequence of the lines between the shared prefix and suffix. */
function hunks(a: string[], b: string[]): Hunk[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  if (!am.length && !bm.length) return [];
  // A very large middle is one part rather than a quadratic table.
  if (am.length * bm.length > 4_000_000) return [{ a0: p, a1: a.length - s, b0: p, b1: b.length - s }];
  const n = am.length;
  const m = bm.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Hunk[] = [];
  let open: Hunk | undefined;
  let i = 0;
  let j = 0;
  const close = () => {
    if (open) out.push({ a0: open.a0 + p, a1: i + p, b0: open.b0 + p, b1: j + p });
    open = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      close();
      i++;
      j++;
    } else {
      open ??= { a0: i, a1: i, b0: j, b1: j };
      if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j++;
      else i++;
    }
  }
  close();
  return out;
}
