import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ADVISORY_SCHEMA_URL, AdvisorySchema, advisoryJsonSchema, getProvider, loadAdvisories, publishedAdvisoryJsonSchema } from "@shapi/core";

const advisoriesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories");

describe("seeded advisories", () => {
  const advisories = loadAdvisories(advisoriesDir);

  it("all validate, have unique ids, and reference known providers", () => {
    expect(advisories.length).toBeGreaterThanOrEqual(7);
    expect(new Set(advisories.map((a) => a.id)).size).toBe(advisories.length);
    for (const a of advisories) expect(getProvider(a.provider), a.id).toBeDefined();
  });

  it("include the GitHub workflow_dispatch 204 to 200 case as a critical status-code change", () => {
    const gh = advisories.find((a) => a.id === "github-workflow-dispatch-204-to-200");
    expect(gh).toMatchObject({
      provider: "github",
      changeClass: "status-code",
      severity: "critical",
      trigger: { statusCodes: [204] },
      endpoint: { method: "POST", path: "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches" },
    });
  });

  it("cover QuickBooks, Xero, Reddit, Meta Graph and a dated upcoming deadline", () => {
    const providers = new Set(advisories.map((a) => a.provider));
    for (const p of ["quickbooks", "xero", "reddit", "meta-graph", "hubspot"]) expect(providers.has(p), p).toBe(true);
  });
});

describe("AdvisorySchema", () => {
  const base = {
    id: "x-y",
    provider: "github",
    title: "t",
    summary: "s",
    endpoint: { method: "*", path: "/a" },
    changeClass: "auth",
    trigger: { any: true },
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2026-01-01",
    severity: "low",
    migrationNote: "m",
    sources: ["https://example.com"],
    status: "verified",
  };

  it("accepts a minimal advisory and rejects bad ones", () => {
    expect(AdvisorySchema.safeParse(base).success).toBe(true);
    expect(AdvisorySchema.safeParse({ ...base, trigger: {} }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, changeClass: "vibes" }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, effectiveDate: "Jan 1" }).success).toBe(false);
    expect(AdvisorySchema.safeParse({ ...base, sources: [] }).success).toBe(false);
  });

  it("rejects triggers that can never fire", () => {
    for (const trigger of [{ newStatusCodes: [200] }, { fields: [] }, { statusCodes: [] }, { any: false }, { enums: [], any: false }]) {
      expect(AdvisorySchema.safeParse({ ...base, trigger }).success, JSON.stringify(trigger)).toBe(false);
    }
    for (const trigger of [{ statusCodes: [204], newStatusCodes: [200] }, { fields: [], any: true }, { enums: [{ field: "Class", values: ["ULTRA"] }] }]) {
      expect(AdvisorySchema.safeParse({ ...base, trigger }).success, JSON.stringify(trigger)).toBe(true);
    }
    expect(AdvisorySchema.safeParse({ ...base, trigger: { enums: [{ field: "Class", values: [] }] } }).success).toBe(false);
  });

  it("loadAdvisories names the bad file and enforces id-based file names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-adv-"));
    writeFileSync(path.join(dir, "wrong-name.json"), JSON.stringify(base));
    expect(() => loadAdvisories(dir)).toThrow(/wrong-name.json must be named x-y.json/);
    writeFileSync(path.join(dir, "wrong-name.json"), JSON.stringify({ ...base, severity: "huge" }));
    expect(() => loadAdvisories(dir)).toThrow(/invalid advisory wrong-name.json/);
  });
});

describe("advisory JSON Schema", () => {
  it("keeps schema/advisory.schema.json in sync (UPDATE_SCHEMA=1 rewrites it)", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schema", "advisory.schema.json");
    const generated = JSON.stringify(advisoryJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA || !existsSync(file)) writeFileSync(file, generated);
    expect(readFileSync(file, "utf8")).toBe(generated);
  });

  it("publishes it at shapi.dev/schema/advisory.json, in sync (S-01; UPDATE_SCHEMA=1 rewrites it)", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "site", "public", "schema", "advisory.json");
    const generated = JSON.stringify(publishedAdvisoryJsonSchema(), null, 2) + "\n";
    if (process.env.UPDATE_SCHEMA || !existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, generated);
    }
    expect(readFileSync(file, "utf8")).toBe(generated);
    expect(JSON.parse(generated)).toMatchObject({ $id: ADVISORY_SCHEMA_URL, $schema: "https://json-schema.org/draft/2020-12/schema" });
  });

  it("every advisory validates against the published schema with a standard validator (Ajv, draft 2020-12, formats checked)", () => {
    // Strict, except strictRequired: the "at least one" rules list `required` keys that the parent schema defines.
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    addFormats.default(ajv);
    const check = ajv.compile(publishedAdvisoryJsonSchema());
    const files = readdirSync(advisoriesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(64);
    const invalid = files.filter((f) => !check(JSON.parse(readFileSync(path.join(advisoriesDir, f), "utf8")))).map((f) => `${f}: ${ajv.errorsText(check.errors)}`);
    expect(invalid).toEqual([]);
    // It rejects what zod rejects.
    const github = JSON.parse(readFileSync(path.join(advisoriesDir, "github-workflow-dispatch-204-to-200.json"), "utf8")) as Record<string, unknown>;
    expect(check({ ...github, trigger: {} })).toBe(false);
    expect(check({ ...github, severity: "huge" })).toBe(false);
    expect(check({ ...github, effectiveDate: "next week" })).toBe(false);
  });

  const schema = advisoryJsonSchema() as Json;
  const seeded = loadAdvisories(advisoriesDir).map((a) => JSON.parse(readFileSync(path.join(advisoriesDir, `${a.id}.json`), "utf8")) as unknown);

  it("uses only keywords and formats a standard validator knows", () => {
    const keywords = new Set<string>();
    const formats = new Set<unknown>();
    const walk = (node: Json) => {
      for (const [k, v] of Object.entries(node)) {
        keywords.add(k);
        if (k === "format") formats.add(v);
        if (k === "properties") for (const sub of Object.values(v as Record<string, Json>)) walk(sub);
        else if (k === "items") walk(v as Json);
        else if (k === "anyOf") for (const sub of v as Json[]) walk(sub);
      }
    };
    walk(schema);
    expect([...keywords].filter((k) => !(k in KEYWORDS) && k !== "$schema" && k !== "format")).toEqual([]);
    expect([...formats].filter((f) => !["date", "date-time", "uri"].includes(f as string))).toEqual([]);
  });

  it("accepts every seeded advisory, extra keys included, and rejects what zod rejects", () => {
    for (const advisory of seeded) expect(validate(schema, advisory), (advisory as { id: string }).id).toEqual([]);
    const github = seeded.find((a) => (a as { id: string }).id === "github-workflow-dispatch-204-to-200") as Record<string, unknown>;
    expect(validate(schema, { $schema: "./schema/advisory.schema.json", ...github })).toEqual([]);
    expect(validate(schema, { ...github, trigger: {} })).not.toEqual([]);
    expect(validate(schema, { ...github, trigger: { newStatusCodes: [200] } })).not.toEqual([]);
    expect(validate(schema, { ...github, trigger: { fields: [] } })).not.toEqual([]);
    expect(validate(schema, { ...github, fix: {} })).not.toEqual([]);
    expect(validate(schema, { ...github, endpoint: { method: "POST", path: "repos" } })).not.toEqual([]);
  });
});

type Json = Record<string, unknown>;

/** The JSON Schema keywords the advisory schema uses, checked the way a standard validator checks them. */
const KEYWORDS: Record<string, (rule: unknown, value: unknown, schema: Json) => boolean> = {
  type: (t, v) => (t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "null" ? v === null : t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === t),
  enum: (e, v) => (e as unknown[]).includes(v),
  const: (c, v) => c === v,
  pattern: (p, v) => typeof v !== "string" || new RegExp(p as string, "u").test(v),
  minLength: (n, v) => typeof v !== "string" || v.length >= (n as number),
  minItems: (n, v) => !Array.isArray(v) || v.length >= (n as number),
  minimum: (n, v) => typeof v !== "number" || v >= (n as number),
  maximum: (n, v) => typeof v !== "number" || v <= (n as number),
  required: (r, v) => typeof v !== "object" || v === null || (r as string[]).every((k) => k in v),
  properties: () => true,
  items: () => true,
  anyOf: () => true,
};

function validate(schema: Json, value: unknown, at = "$"): string[] {
  const errors: string[] = [];
  for (const [k, rule] of Object.entries(schema)) if (KEYWORDS[k] && !KEYWORDS[k](rule, value, schema)) errors.push(`${at}: ${k}`);
  if (schema.properties && typeof value === "object" && value !== null) {
    for (const [k, sub] of Object.entries(schema.properties as Record<string, Json>)) if (k in value) errors.push(...validate(sub, (value as Json)[k], `${at}.${k}`));
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => errors.push(...validate(schema.items as Json, v, `${at}[${i}]`)));
  if (schema.anyOf && !(schema.anyOf as Json[]).some((sub) => validate(sub, value, at).length === 0)) errors.push(`${at}: anyOf`);
  return errors;
}
