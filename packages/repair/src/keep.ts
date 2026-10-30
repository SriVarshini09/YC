import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Advisory, CallSite, LockedCallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

/**
 * Whether a fix keeps what it is fixing (execution plan V-06): the call to the changed endpoint and the read of
 * what changed. A "fix" that deletes the call, the status check or the field read can make a contract test pass
 * without fixing anything.
 *
 * Both versions of the changed files are read the same way, alone (with package.json, so SDK clients are known),
 * and only a removal SHAPI can see counts: when it cannot find the call in the original files either (a base URL
 * from another file, say), the check reports `not-checked` rather than guess.
 */
export interface KeepCheck {
  status: "kept" | "removed" | "not-checked";
  detail: string;
}

export interface KeepInput {
  advisory: Advisory;
  callSite: LockedCallSite;
  /** Every file the fix changed, before and after; `before` is "" for a file it created. */
  files: { file: string; before: string; after: string }[];
  /** The repository's package.json, when it has one. */
  packageJson?: string;
}

export function checkKept(input: KeepInput): KeepCheck {
  const { advisory, callSite } = input;
  const before = sites(input.files.filter((f) => f.before !== "").map((f) => ({ file: f.file, content: f.before })), input.packageJson);
  const original = closest(before.filter((s) => s.file === callSite.file && same(s, callSite, callSite.endpoint)), callSite.line);
  if (!original) return { status: "not-checked", detail: `SHAPI cannot see the call at ${callSite.file}:${callSite.line} in the changed files alone, so it did not check that the fix keeps it` };

  const after = sites(input.files.map((f) => ({ file: f.file, content: f.after })), input.packageJson);
  const target = movedPath(callSite.endpoint, advisory);
  const candidates = after.filter((s) => same(s, callSite, callSite.endpoint) || (target !== undefined && same(s, callSite, target)));
  const kept = closest(candidates.filter((s) => s.file === callSite.file), callSite.line) ?? candidates[0];
  const call = `${callSite.method ?? "the"} ${callSite.endpoint ?? "call"}`;
  if (!kept) return { status: "removed", detail: `the change removes the call to ${call}` };

  const missing = lostReads(original, kept, advisory);
  if (missing.length) return { status: "removed", detail: `the change stops ${missing.join(" and ")} at ${call}` };
  return { status: "kept", detail: `the change keeps the call to ${call} and what it reads` };
}

/** What the original call site read or sent that the advisory turns on, and the fixed one no longer does. */
function lostReads(before: CallSite, after: CallSite, advisory: Advisory): string[] {
  const t = advisory.trigger;
  const fix = advisory.fix;
  const lost: string[] = [];
  const under = (field: string, name: string) => field === name || field.startsWith(`${name}.`) || field.startsWith(`${name}[]`);
  for (const name of t.fields ?? []) {
    if (!before.surface.fields.some((f) => under(f, name))) continue;
    const renamed = fix?.fields?.find((r) => r.from === name)?.to;
    if (!after.surface.fields.some((f) => under(f, name) || (renamed !== undefined && under(f, renamed)))) lost.push(`reading ${name}`);
  }
  const checksStatus = (s: CallSite) => s.surface.statusCodes.length > 0 || s.surface.checksOk;
  if ((t.statusCodes?.length ?? 0) > 0 && checksStatus(before) && !checksStatus(after)) lost.push("checking the status");
  for (const e of t.enums ?? []) {
    if (before.surface.enums.some((x) => x.field === e.field) && !after.surface.enums.some((x) => x.field === e.field)) lost.push(`comparing ${e.field}`);
  }
  const sends = (list: { name: string }[] | undefined, name: string) => (list ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase());
  for (const q of t.query ?? []) if (sends(before.surface.query, q.name) && !sends(after.surface.query, q.name)) lost.push(`sending ${q.name}`);
  for (const h of t.headers ?? []) if (sends(before.surface.headers, h.name) && !sends(after.surface.headers, h.name)) lost.push(`sending the ${h.name} header`);
  for (const b of t.body ?? []) if (sends(before.surface.body, b.field) && !sends(after.surface.body, b.field)) lost.push(`sending ${b.field}`);
  return lost;
}

/** The call site's endpoint after the advisory's path fix (`/v21.0/` to `/v26.0/`), when it has one. */
function movedPath(endpoint: string | null, advisory: Advisory): string | undefined {
  const p = advisory.fix?.path;
  return endpoint && p && endpoint.includes(p.from) ? endpoint.replace(p.from, p.to) : undefined;
}

function same(site: CallSite, original: LockedCallSite, endpoint: string | null): boolean {
  return site.provider === original.provider && site.method === original.method && site.endpoint === endpoint;
}

function closest(sites: CallSite[], line: number): CallSite | undefined {
  return [...sites].sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
}

/** Call sites in these files alone, written to a temporary folder. */
function sites(files: { file: string; content: string }[], packageJson: string | undefined): CallSite[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-keep-"));
  try {
    if (packageJson !== undefined) writeFileSync(path.join(dir, "package.json"), packageJson);
    for (const f of files) {
      const abs = path.join(dir, f.file);
      if (!abs.startsWith(dir + path.sep)) continue;
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    return extractCallSites(dir).callSites;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
