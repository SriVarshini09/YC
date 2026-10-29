import path from "node:path";
import { runFailure } from "./runner";
import type { Workspace } from "./workspace";

/** Whether a change type-checks: vitest strips types, so a fix can pass its test and still fail the repository's `tsc`. */
export interface TypeCheck {
  status: "passed" | "failed" | "skipped";
  /** What ran and what it found, or why nothing was checked. */
  detail: string;
}

/** The repository's type errors before a change, to compare with after it; or why it cannot be type-checked. */
export type TypeBaseline = { tsconfig: string; errors: string[] } | { skipped: string };

/** The first of `dir` (repo-relative POSIX) and the folders above it, up to the repository root (""), that `has` accepts. */
export async function upward(dir: string, has: (d: string) => boolean | Promise<boolean>): Promise<string | undefined> {
  for (let d = dir; ; d = path.posix.dirname(d)) {
    const rel = d === "." || d === "/" ? "" : d;
    if (await has(rel)) return rel;
    if (rel === "") return undefined;
  }
}

/**
 * tsc's errors as "file: TS1234 message", without positions so an edit that moves lines changes
 * nothing. Undefined when tsc did not get as far as checking (a config error, a crash, a timeout).
 */
export function tscErrors(run: { exitCode: number; output: string }): string[] | undefined {
  if (/^error TS\d+:/m.test(run.output) || /timed out\)?$/m.test(run.output)) return undefined;
  const errors = [...run.output.matchAll(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/gm)].map(([, file, code, message]) => `${file!.trim().replaceAll("\\", "/")}: ${code} ${message!.trim()}`);
  // tsc exits 1 or 2 when it reports errors; anything else, or a failure with none listed, is not a check.
  if (run.exitCode === 0 ? errors.length > 0 : !(run.exitCode === 1 || run.exitCode === 2) || errors.length === 0) return undefined;
  return errors;
}

/** Type-check the project holding `file` (its nearest tsconfig.json) before a change. */
export async function typeBaseline(ws: Workspace, file: string): Promise<TypeBaseline> {
  if (!ws.typecheck) return { skipped: "this workspace cannot run tsc" };
  let config: string | undefined;
  const dir = await upward(path.posix.dirname(file), async (d) => (config = await ws.read(path.posix.join(d, "tsconfig.json"))) !== undefined);
  if (dir === undefined || config === undefined) return { skipped: `no tsconfig.json above ${file}` };
  const tsconfig = path.posix.join(dir, "tsconfig.json");
  // A solution config ("files": [] plus references) checks nothing itself.
  if (/"files"\s*:\s*\[\s*\]/.test(config)) return { skipped: `${tsconfig} only references other projects` };
  const run = await ws.typecheck(tsconfig);
  if (!run) return { skipped: "TypeScript is not installed in the repository" };
  const errors = tscErrors(run);
  if (!errors) return { skipped: `tsc could not check ${tsconfig}: ${runFailure(run.output)}` };
  return { tsconfig, errors };
}

/** Type-check again after a change: it fails on any error that was not there before. */
export async function checkTypes(ws: Workspace, base: TypeBaseline): Promise<TypeCheck> {
  if ("skipped" in base) return { status: "skipped", detail: `not type-checked: ${base.skipped}` };
  const run = await ws.typecheck!(base.tsconfig);
  const errors = run && tscErrors(run);
  if (!errors) return { status: "skipped", detail: `not type-checked: tsc could not check ${base.tsconfig} after the change${run ? `: ${runFailure(run.output)}` : ""}` };
  const left = new Map<string, number>();
  for (const e of base.errors) left.set(e, (left.get(e) ?? 0) + 1);
  const added = errors.filter((e) => {
    const n = left.get(e) ?? 0;
    left.set(e, n - 1);
    return n <= 0;
  });
  const command = `tsc --noEmit -p ${base.tsconfig}`;
  if (!added.length) return { status: "passed", detail: `${command}: no new errors` };
  return { status: "failed", detail: `${command}: ${added.length} new error${added.length === 1 ? "" : "s"}: ${added.slice(0, 3).join("; ")}` };
}
