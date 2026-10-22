import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AdvisorySchema, getProvider, type Advisory, type ChangeClass, type Severity, type Trigger } from "@shapi/core";
import type { ShapeChange, ShapeDiff, StoredObservation } from "@shapi/shapes";

export interface DraftInput {
  before: StoredObservation;
  after: StoredObservation;
  diff: ShapeDiff;
}

const SEVERITY: Record<ChangeClass, Severity> = {
  "status-code": "critical",
  auth: "critical",
  "field-rename": "high",
  "required-field": "high",
  "version-sunset": "high",
  "enum-added": "medium",
  "scope-change": "medium",
};

/**
 * Turn an observed breaking change into a draft advisory for human review.
 * Returns undefined when nothing in the diff maps to an advisory change class
 * with breaking impact (or a sunset signal).
 */
export function draftAdvisory({ before, after, diff }: DraftInput): Advisory | undefined {
  const primary =
    diff.changes.find((c) => c.impact === "breaking" && c.changeClass) ??
    diff.changes.find((c) => c.changeClass === "version-sunset");
  if (!primary?.changeClass) return undefined;

  const { provider, method, endpoint } = after;
  const day = after.observedAt.slice(0, 10);
  const changeClass = primary.changeClass;
  const relevant = diff.changes.filter((c) => c.impact === "breaking" || c === primary);

  return AdvisorySchema.parse({
    id: `${provider}-${slug(endpoint)}-${changeClass}-${day.replaceAll("-", "")}`,
    provider,
    title: title(method, endpoint, primary),
    summary:
      `SHAPI observed ${method} ${endpoint} change between ${before.observedAt} and ${after.observedAt} ` +
      `(source: ${after.source}): ${relevant.map((c) => c.detail).join("; ")}. Machine-drafted; review before publishing.`,
    endpoint: { method, path: endpoint },
    changeClass,
    trigger: trigger(diff.changes.filter((c) => c.changeClass === changeClass && (c.impact === "breaking" || c === primary))),
    firstObserved: day,
    publishedNotice: null,
    effectiveDate: day,
    severity: SEVERITY[changeClass],
    migrationNote: migration(primary),
    sources: [getProvider(provider)?.docsUrl ?? "https://shapi.dev"],
    status: "unverified",
    evidence: {
      source: after.source,
      before: { observedAt: before.observedAt, status: before.shape.status, shapeHash: before.shapeHash },
      after: { observedAt: after.observedAt, status: after.shape.status, shapeHash: after.shapeHash },
      changes: diff.changes.map((c) => `${c.impact}: ${c.detail}`),
    },
  });
}

function trigger(changes: ShapeChange[]): Trigger {
  const t: Trigger = {};
  for (const c of changes) {
    if (c.changeClass === "status-code" && typeof c.from === "number") t.statusCodes = [...(t.statusCodes ?? []), c.from];
    else if ((c.changeClass === "field-rename" || c.changeClass === "required-field") && c.kind !== "header-changed" && c.kind !== "body-kind" && c.path) {
      t.fields = [...(t.fields ?? []), c.path];
    } else if (c.changeClass === "enum-added" && c.path) t.enums = [...(t.enums ?? []), { field: c.path }];
  }
  return Object.keys(t).length > 0 ? t : { any: true };
}

function title(method: string, endpoint: string, c: ShapeChange): string {
  if (c.changeClass === "status-code") return `${method} ${endpoint} returns ${c.to} instead of ${c.from}`;
  return `${method} ${endpoint}: ${c.detail}`;
}

function migration(c: ShapeChange): string {
  switch (c.changeClass) {
    case "status-code":
      return `Accept ${c.to} as well as ${c.from} (treat any 2xx as success) and stop requiring an empty body.`;
    case "auth":
      return "Check credentials and scopes for this endpoint; the provider now refuses the request.";
    case "version-sunset":
      return "Move to the provider's replacement endpoint or a supported API version.";
    case "required-field":
      return `Handle null for ${c.path ?? "the field"}.`;
    case "enum-added":
      return `Handle unknown values of ${c.path ?? "the field"} instead of failing on them.`;
    default:
      return `Update code that reads ${c.path ?? "the response"} to the new shape.`;
  }
}

/** Last two literal path segments, for readable ids: /repos/{o}/{r}/actions/workflows/{id}/dispatches → workflows-dispatches. */
function slug(endpoint: string): string {
  const literal = endpoint
    .split("/")
    .filter((s) => s && !s.includes("{"))
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
    .filter(Boolean);
  return literal.slice(-2).join("-") || "root";
}

/** Write a draft as `<dir>/<id>.json`; returns the file path. */
export function writeDraft(advisory: Advisory, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${advisory.id}.json`);
  writeFileSync(file, JSON.stringify(advisory, null, 2) + "\n");
  return file;
}
