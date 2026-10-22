import type { ChangeClass } from "@shapi/core";
import type { FieldShape, ResponseShape } from "./shape";

export type ChangeKind =
  | "status-code"
  | "body-kind"
  | "field-removed"
  | "field-added"
  | "type-changed"
  | "became-nullable"
  | "no-longer-nullable"
  | "enum-value-added"
  | "class-changed"
  | "header-changed"
  | "header-added"
  | "header-removed";

export type Impact = "breaking" | "non-breaking" | "informational";

export interface ShapeChange {
  kind: ChangeKind;
  impact: Impact;
  /** Advisory change class, when the change maps to one. */
  changeClass?: ChangeClass;
  /** Field path (clear text when known) or header name. */
  path?: string;
  pathHash?: string;
  from?: string | number | string[];
  to?: string | number | string[];
  detail: string;
}

export interface ShapeDiff {
  changes: ShapeChange[];
  breaking: boolean;
}

const IMPACT_ORDER: Record<Impact, number> = { breaking: 0, "non-breaking": 1, informational: 2 };

/** Headers whose value changing is a contract change rather than metadata. */
const CONTRACT_HEADERS = new Set(["content-type"]);
const SUNSET_HEADERS = new Set(["deprecation", "sunset", "link-deprecation"]);

/** Compare two shapes of the same endpoint and classify every difference. */
export function diffShapes(before: ResponseShape, after: ResponseShape): ShapeDiff {
  const changes: ShapeChange[] = [];
  const ok = (s: number) => s >= 200 && s < 300;

  if (before.status !== after.status) changes.push(statusChange(before.status, after.status));

  if (before.body.kind !== after.body.kind) {
    const lost = before.body.kind === "json" && after.body.kind !== "json";
    changes.push({
      kind: "body-kind",
      impact: lost && ok(after.status) ? "breaking" : "informational",
      ...(lost && ok(after.status) ? { changeClass: "field-rename" as const } : {}),
      from: before.body.kind,
      to: after.body.kind,
      detail: `body ${before.body.kind} → ${after.body.kind}`,
    });
  }

  // Comparing fields across a success/error boundary says nothing about the contract.
  if (ok(before.status) === ok(after.status) && before.body.kind === "json" && after.body.kind === "json") {
    changes.push(...fieldChanges(before.body.fields, after.body.fields));
  }
  changes.push(...headerChanges(before, after));

  changes.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || (a.path ?? "").localeCompare(b.path ?? ""));
  return { changes, breaking: changes.some((c) => c.impact === "breaking") };
}

function statusChange(from: number, to: number): ShapeChange {
  const ok = (s: number) => s >= 200 && s < 300;
  const base = { kind: "status-code" as const, from, to, detail: `status ${from} → ${to}` };
  if (ok(from) && ok(to)) return { ...base, impact: "breaking", changeClass: "status-code" };
  if (ok(from) && (to === 401 || to === 403)) return { ...base, impact: "breaking", changeClass: "auth" };
  if (ok(from) && (to === 404 || to === 410)) return { ...base, impact: "breaking", changeClass: "version-sunset" };
  // 5xx, 429 and recoveries are availability, not contract
  return { ...base, impact: "informational" };
}

function label(f: FieldShape): string {
  return f.path ?? `#${f.pathHash}`;
}

function fieldChanges(before: FieldShape[], after: FieldShape[]): ShapeChange[] {
  const out: ShapeChange[] = [];
  const prev = new Map(before.map((f) => [f.pathHash, f]));
  const next = new Map(after.map((f) => [f.pathHash, f]));
  const removedPaths: string[] = [];
  const addedPaths: string[] = [];
  const under = (path: string | undefined, roots: string[]) =>
    path !== undefined && roots.some((r) => path.startsWith(`${r}.`) || path.startsWith(`${r}[]`));

  for (const f of before) {
    if (next.has(f.pathHash)) continue;
    if (under(f.path, removedPaths)) continue;
    if (f.path) removedPaths.push(f.path);
    out.push({
      kind: "field-removed",
      impact: "breaking",
      changeClass: "field-rename",
      path: f.path,
      pathHash: f.pathHash,
      from: f.types,
      detail: `field ${label(f)} removed`,
    });
  }

  for (const f of after) {
    const old = prev.get(f.pathHash);
    if (!old) {
      if (under(f.path, addedPaths)) continue;
      if (f.path) addedPaths.push(f.path);
      out.push({
        kind: "field-added",
        impact: "non-breaking",
        path: f.path,
        pathHash: f.pathHash,
        to: f.types,
        detail: `field ${label(f)} added (${f.types.join(" | ")})`,
      });
      continue;
    }
    const where = { path: f.path ?? old.path, pathHash: f.pathHash };
    const name = f.path ?? old.path ?? `#${f.pathHash}`;
    const newTypes = f.types.filter((t) => !old.types.includes(t));
    const goneTypes = old.types.filter((t) => !f.types.includes(t));
    const nonNullNew = newTypes.filter((t) => t !== "null");
    if (nonNullNew.length > 0) {
      out.push({
        kind: "type-changed",
        impact: "breaking",
        changeClass: "field-rename",
        ...where,
        from: old.types,
        to: f.types,
        detail: `field ${name} type ${old.types.join(" | ")} → ${f.types.join(" | ")}`,
      });
    } else if (newTypes.includes("null")) {
      out.push({
        kind: "became-nullable",
        impact: "breaking",
        changeClass: "required-field",
        ...where,
        from: old.types,
        to: f.types,
        detail: `field ${name} can now be null`,
      });
    } else if (goneTypes.includes("null") && goneTypes.length === 1) {
      out.push({ kind: "no-longer-nullable", impact: "informational", ...where, detail: `field ${name} no longer seen as null` });
    }

    const added = (f.valueHashes ?? []).filter((h) => !(old.valueHashes ?? []).includes(h));
    if (enumLike(old) && added.length > 0) {
      out.push({
        kind: "enum-value-added",
        impact: "breaking",
        changeClass: "enum-added",
        ...where,
        to: added,
        detail: `field ${name} has ${added.length} value${added.length === 1 ? "" : "s"} not seen before`,
      });
    }

    const newClasses = f.classes.filter((c) => !old.classes.includes(c));
    if (nonNullNew.length === 0 && newClasses.length > 0 && old.classes.length > 0 && !newClasses.every((c) => ["positive", "negative", "zero", "true", "false"].includes(c))) {
      out.push({
        kind: "class-changed",
        impact: "informational",
        ...where,
        from: old.classes,
        to: f.classes,
        detail: `field ${name} values look like ${f.classes.join(", ")} (were ${old.classes.join(", ")})`,
      });
    }
  }
  return out;
}

/**
 * A field is treated as an enum once values repeat: at least twice as many
 * occurrences as distinct values. One sighting of "x" says nothing about the
 * value set, so a different value next time is not a new enum member.
 */
function enumLike(f: FieldShape): boolean {
  const distinct = f.valueHashes?.length ?? 0;
  return distinct > 0 && f.occurrences >= 2 * distinct;
}

function headerChanges(before: ResponseShape, after: ResponseShape): ShapeChange[] {
  const out: ShapeChange[] = [];
  const names = new Set([...Object.keys(before.headers), ...Object.keys(after.headers)]);
  for (const name of [...names].sort()) {
    const from = before.headers[name];
    const to = after.headers[name];
    if (from === to) continue;
    if (SUNSET_HEADERS.has(name) && from === undefined) {
      out.push({ kind: "header-added", impact: "informational", changeClass: "version-sunset", path: name, to, detail: `response now carries ${name}: ${to}` });
    } else if (from === undefined || to === undefined) {
      out.push({
        kind: from === undefined ? "header-added" : "header-removed",
        impact: "informational",
        path: name,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        detail: from === undefined ? `header ${name}: ${to} added` : `header ${name} removed`,
      });
    } else {
      const contract = CONTRACT_HEADERS.has(name) && before.status === after.status;
      out.push({
        kind: "header-changed",
        impact: contract ? "breaking" : "informational",
        ...(contract ? { changeClass: "field-rename" as const } : {}),
        path: name,
        from,
        to,
        detail: `header ${name}: ${from} → ${to}`,
      });
    }
  }
  const prevNames = new Set(before.headerNames);
  const nextNames = new Set(after.headerNames);
  for (const name of after.headerNames) {
    if (!prevNames.has(name)) out.push({ kind: "header-added", impact: "informational", path: name, detail: `header ${name} added` });
  }
  for (const name of before.headerNames) {
    if (!nextNames.has(name)) out.push({ kind: "header-removed", impact: "informational", path: name, detail: `header ${name} removed` });
  }
  return out;
}
