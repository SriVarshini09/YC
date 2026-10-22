import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HTTP_METHODS } from "./providers";

export const CHANGE_CLASSES = [
  "status-code",
  "field-rename",
  "enum-added",
  "required-field",
  "version-sunset",
  "scope-change",
  "auth",
] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

const IsoDate = z.iso.date();

/**
 * Which call sites an advisory applies to. `path` is a pattern: `{name}` matches
 * one segment, `*` matches within a segment, `**` matches any number of segments.
 */
export const EndpointPatternSchema = z.object({
  method: z.union([z.enum(HTTP_METHODS), z.literal("*")]),
  path: z.string().startsWith("/"),
  /** Limit to these hosts (for providers whose hosts behave differently). */
  hosts: z.array(z.string()).optional(),
});
export type EndpointPattern = z.infer<typeof EndpointPatternSchema>;

/** The part of a call site's dependency surface that makes it affected rather than merely exposed. */
export const TriggerSchema = z
  .object({
    /** Affected when the code compares the status against one of these (the old codes). */
    statusCodes: z.array(z.number().int()).optional(),
    /**
     * The codes the provider answers with now. Code that already compares
     * against all of them handles the change and is not affected.
     */
    newStatusCodes: z.array(z.number().int()).optional(),
    /** Affected when the code reads one of these body fields (or a field beneath it). */
    fields: z.array(z.string()).optional(),
    /** Affected when the code compares this field against string values. */
    enums: z.array(z.object({ field: z.string() })).optional(),
    /** Affected when the request sets this header (optionally to one of these values). */
    headers: z.array(z.object({ name: z.string(), values: z.array(z.string()).optional() })).optional(),
    /** Affected when the request sets this query parameter (optionally to a number below `below`). */
    query: z.array(z.object({ name: z.string(), below: z.number().optional() })).optional(),
    /** Every call to the endpoint is affected (sunsets, auth and scope changes). */
    any: z.boolean().optional(),
  })
  .refine((t) => Object.values(t).some((v) => v !== undefined && v !== false), "trigger needs at least one condition");
export type Trigger = z.infer<typeof TriggerSchema>;

export const AdvisorySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  provider: z.string(),
  title: z.string().min(1),
  summary: z.string().min(1),
  endpoint: EndpointPatternSchema,
  changeClass: z.enum(CHANGE_CLASSES),
  trigger: TriggerSchema,
  /** When the changed behavior was first seen in the wild. */
  firstObserved: IsoDate.nullable(),
  /** The provider's own notice, if there was one. */
  publishedNotice: z.object({ date: IsoDate.nullable(), url: z.url() }).nullable(),
  /** When the change takes (or took) effect. */
  effectiveDate: IsoDate,
  severity: z.enum(SEVERITIES),
  migrationNote: z.string().min(1),
  recipeId: z.string().optional(),
  sources: z.array(z.url()).min(1),
  /** "verified": checked against a primary or two independent sources. "unverified": secondary reports only. */
  status: z.enum(["verified", "unverified"]),
  /** Observations behind a machine-drafted advisory: what SHAPI saw before and after the change. */
  evidence: z
    .object({
      source: z.string(),
      before: z.object({ observedAt: z.iso.datetime(), status: z.number().int(), shapeHash: z.string() }),
      after: z.object({ observedAt: z.iso.datetime(), status: z.number().int(), shapeHash: z.string() }),
      changes: z.array(z.string()),
    })
    .optional(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

/** Load every `*.json` advisory directly in `dir` (subfolders such as `drafts/` are skipped), sorted by id. */
export function loadAdvisories(dir: string): Advisory[] {
  const advisories: Advisory[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const parsed = AdvisorySchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error(`invalid advisory ${name}: ${z.prettifyError(parsed.error)}`);
    const advisory = parsed.data;
    if (`${advisory.id}.json` !== name) throw new Error(`advisory ${name} must be named ${advisory.id}.json`);
    if (seen.has(advisory.id)) throw new Error(`duplicate advisory id ${advisory.id}`);
    seen.add(advisory.id);
    advisories.push(advisory);
  }
  return advisories.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function advisoryJsonSchema(): unknown {
  return z.toJSONSchema(AdvisorySchema);
}
