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
 * one segment, `*` matches within a segment, `**` matches any number of segments,
 * and `{?}` matches only a value the code builds at runtime, never a literal.
 */
export const EndpointPatternSchema = z.object({
  method: z.union([z.enum(HTTP_METHODS), z.literal("*")]),
  path: z.string().regex(/^\//, "path must start with /"),
  /** Limit to these hosts (for providers whose hosts behave differently). */
  hosts: z.array(z.string()).optional(),
});
export type EndpointPattern = z.infer<typeof EndpointPatternSchema>;

/** Trigger lists that can make a call site affected. `newStatusCodes` only suppresses `statusCodes`. */
const TRIGGER_CONDITIONS = ["statusCodes", "fields", "enums", "headers", "query", "body"] as const;

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
    /**
     * Affected when the code compares this field against literal values (numbers count as their decimal
     * string), optionally only when one of them is in `values`.
     */
    enums: z.array(z.object({ field: z.string(), values: z.array(z.string()).min(1).optional() })).optional(),
    /** Affected when the request sets this header (optionally to one of these values). */
    headers: z.array(z.object({ name: z.string(), values: z.array(z.string()).optional() })).optional(),
    /**
     * Affected when the request sets this query parameter: optionally to a number below `below`, or to
     * one of `values` (a comma-separated value such as `metric=a,b` matches when any item does).
     */
    query: z.array(z.object({ name: z.string(), below: z.number().optional(), values: z.array(z.string()).optional() })).optional(),
    /**
     * Affected when the request body sets this top-level field, optionally to one of these values
     * (for example `model` set to a retired model). A value the scanner cannot read statically is not a match.
     */
    body: z.array(z.object({ field: z.string().min(1), values: z.array(z.string()).min(1).optional() })).optional(),
    /** Every call to the endpoint is affected (sunsets, auth and scope changes). */
    any: z.boolean().optional(),
  })
  .refine(
    (t) => t.any === true || TRIGGER_CONDITIONS.some((k) => (t[k]?.length ?? 0) > 0),
    "trigger needs at least one condition: any, or a non-empty statusCodes, fields, enums, headers, query or body",
  );
export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * The deterministic change that fixes an affected call site, applied by the `apply-fix` recipe.
 * Request parts change what the code sends; `fields` and `enums` change how it reads the response.
 */
export const FixSchema = z
  .object({
    /** Replace this part of the request path, for example "/v21.0/" with "/v26.0/". */
    path: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(),
    /** Send this query parameter with this value, for example minorversion=75. */
    query: z.object({ name: z.string().min(1), value: z.string() }).optional(),
    /** Send this request header with this value, for example Stripe-Version. */
    header: z.object({ name: z.string().min(1), value: z.string() }).optional(),
    /** Response fields that were renamed: the code reads the new name, falling back to the old one. */
    fields: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).optional(),
    /** Enum values that were renamed: comparisons with an old value also accept the new one. */
    enums: z.array(z.object({ field: z.string().min(1), values: z.array(z.object({ from: z.string(), to: z.string() })).min(1) })).optional(),
  })
  .refine((f) => Object.values(f).some((v) => v !== undefined), "fix needs at least one change");
export type Fix = z.infer<typeof FixSchema>;

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
  /** When the change takes (or took) effect, as a UTC calendar day. */
  effectiveDate: IsoDate,
  severity: z.enum(SEVERITIES),
  migrationNote: z.string().min(1),
  recipeId: z.string().optional(),
  /** What `recipeId: "apply-fix"` changes. */
  fix: FixSchema.optional(),
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

/** Where the advisory JSON Schema is published (execution plan S-01): site/public/schema/advisory.json, served by shapi.dev. */
export const ADVISORY_SCHEMA_URL = "https://shapi.dev/schema/advisory.json";

/**
 * The JSON Schema for advisory files. Input mode leaves unknown keys allowed, as zod strips them, and the
 * two "at least one" refinements, which JSON Schema cannot derive from zod, are spelled out.
 */
export function advisoryJsonSchema(): unknown {
  return z.toJSONSchema(AdvisorySchema, {
    io: "input",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === TriggerSchema) {
        jsonSchema.anyOf = [
          { required: ["any"], properties: { any: { const: true } } },
          ...TRIGGER_CONDITIONS.map((k) => ({ required: [k], properties: { [k]: { type: "array" as const, minItems: 1 } } })),
        ];
      } else if (zodSchema === FixSchema) {
        jsonSchema.anyOf = Object.keys(jsonSchema.properties ?? {}).map((k) => ({ required: [k] }));
      }
    },
  });
}

/** advisoryJsonSchema() as published at ADVISORY_SCHEMA_URL: the same rules, with its $id, a title and a description. */
export function publishedAdvisoryJsonSchema(): Record<string, unknown> {
  const { $schema, ...rules } = advisoryJsonSchema() as Record<string, unknown>;
  return {
    $schema,
    $id: ADVISORY_SCHEMA_URL,
    title: "SHAPI advisory",
    description: "One third-party API change SHAPI checks code against: the endpoint, what changed, what code it breaks, and when. Advisories live at https://github.com/SriVarshini09/shapi-advisories.",
    ...rules,
  };
}

/**
 * First line of every contract test SHAPI writes. Scans skip files that start with it: the test names
 * the old request on purpose, and would otherwise reopen the problem its own fix closed.
 */
export const GENERATED_TEST_HEADER = "// Generated by SHAPI for advisory ";
