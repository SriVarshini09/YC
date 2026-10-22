#!/usr/bin/env node
// Drift observatory v0: does a public API behave the way its published OpenAPI spec says?
//
// Specs come from the APIs.guru directory. For each API (officially published specs first) we keep GET
// operations that need no auth, no path parameters and no required parameters, call each once, and compare
// the response with the spec: status documented, content type, field types, required fields, enum values,
// and undocumented fields. Stops after TARGET APIs answered.
//
// One API per provider domain (github.com publishes many variants of one API; counting them separately
// would weight the result toward one provider). Unreachable hosts and endpoints that answer 404/410 are
// reported as their own categories, not as schema disagreements.
//
// Usage: node research/scripts/observatory.mjs [--out research/data] [--target 50]

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
const OUT = arg("--out", "research/data");
const TARGET = Number(arg("--target", "50"));
const ENDPOINTS_PER_API = 2;
const UA = "shapi-observatory/0.1 (+https://github.com/SriVarshini09/YC; one request per endpoint)";
const CONCURRENCY = 8;

async function get(url, ms, accept = "application/json") {
  const res = await fetch(url, { headers: { Accept: accept, "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  return { status: res.status, contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), text };
}

// ---------------------------------------------------------------------------
// Specs

function resolveRef(spec, node, depth = 0) {
  let cur = node;
  while (cur && cur.$ref && depth++ < 20) {
    if (!cur.$ref.startsWith("#/")) return undefined; // external refs: out of scope for v0
    cur = cur.$ref.slice(2).split("/").reduce((o, k) => o?.[k.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
  }
  return cur;
}

/** Placeholder hosts used by specs of self-hosted software: there is no public API to probe. */
const PLACEHOLDER_HOST = /(^|\.)(local|localhost|example|example\.(com|org|net)|invalid|test)(:\d+)?$/i;

function baseUrl(spec) {
  let url;
  if (spec.openapi) {
    const u = spec.servers?.[0]?.url;
    url = u && /^https?:\/\//.test(u) && !u.includes("{") ? u.replace(/\/$/, "") : undefined;
  } else if (spec.host && !spec.host.includes("{")) {
    const scheme = spec.schemes?.includes("https") ? "https" : spec.schemes?.[0] ?? "https";
    url = `${scheme}://${spec.host}${(spec.basePath ?? "").replace(/\/$/, "")}`;
  }
  if (!url) return undefined;
  const host = new URL(url).hostname;
  return PLACEHOLDER_HOST.test(host) || /^(127\.|10\.|192\.168\.)/.test(host) ? undefined : url;
}

function isPublic(spec, op) {
  const sec = op.security ?? spec.security;
  return !sec || sec.length === 0 || sec.some((s) => Object.keys(s).length === 0);
}

/** The JSON schema the spec documents for a status code, and whether it documents the status at all. */
function documented(spec, op, status) {
  const responses = op.responses ?? {};
  const key = [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, "default"].find((k) => k in responses);
  if (!key) return { documented: false };
  const r = resolveRef(spec, responses[key]);
  if (spec.openapi) {
    const content = r?.content ?? {};
    const jsonType = Object.keys(content).find((t) => t.includes("json"));
    return { documented: true, viaDefault: key === "default", declaredTypes: Object.keys(content), schema: jsonType ? content[jsonType].schema : undefined };
  }
  const produces = op.produces ?? spec.produces ?? [];
  return { documented: true, viaDefault: key === "default", declaredTypes: produces, schema: r?.schema };
}

function candidates(spec) {
  const base = baseUrl(spec);
  if (!base) return [];
  const out = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    const op = item?.get;
    if (!op || p.includes("{") || !isPublic(spec, op)) continue;
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x) => resolveRef(spec, x) ?? {});
    if (params.some((x) => x.required && x.in !== "header")) continue;
    if (params.some((x) => x.in === "header" && x.required)) continue;
    const ok = documented(spec, op, 200);
    if (!ok.documented || !ok.schema) continue; // only endpoints with a documented JSON success body
    out.push({ path: p, url: `${base}${p}`, op });
    if (out.length >= ENDPOINTS_PER_API) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeOk(schemaTypes, actual) {
  if (schemaTypes.includes(actual)) return true;
  return actual === "integer" && schemaTypes.includes("number");
}

/** Walk a JSON value against a schema and collect disagreements. */
function compare(spec, schemaIn, value, at, f, depth = 0) {
  if (depth > 10 || f.examples.length > 40) return;
  const schema = resolveRef(spec, schemaIn);
  if (!schema || typeof schema !== "object") return;
  if (schema.allOf) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf.map((s) => resolveRef(spec, s)).filter(Boolean)) {
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
      if (part.type) merged.type = part.type;
      if (part.additionalProperties !== undefined) merged.additionalProperties = part.additionalProperties;
    }
    return compare(spec, { ...merged, nullable: schema.nullable }, value, at, f, depth + 1);
  }
  if (schema.oneOf || schema.anyOf) return; // polymorphic: v0 does not judge
  const actual = jsonType(value);
  const nullable = schema.nullable === true || schema["x-nullable"] === true || (Array.isArray(schema.type) && schema.type.includes("null"));
  if (value === null) {
    if (!nullable && schema.type) {
      f.nullNotAllowed++;
      f.examples.push(`${at || "$"}: null, spec says ${[].concat(schema.type).join("|")}`);
    }
    return;
  }
  const types = [].concat(schema.type ?? []).filter((t) => t !== "null");
  if (types.includes("file")) return; // Swagger 2 file download: no JSON contract to compare
  if (types.length && !typeOk(types, actual)) {
    f.typeMismatches++;
    f.examples.push(`${at || "$"}: ${actual}, spec says ${types.join("|")}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    f.enumViolations++;
    f.examples.push(`${at || "$"}: value not in documented enum (${schema.enum.length} values)`);
  }
  if (actual === "array" && schema.items) {
    value.slice(0, 5).forEach((v) => compare(spec, schema.items, v, `${at}[]`, f, depth + 1));
  } else if (actual === "object") {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!(req in value)) {
        f.missingRequired++;
        f.examples.push(`${at ? `${at}.` : ""}${req}: required by spec, absent`);
      }
    }
    const open = schema.additionalProperties === true || typeof schema.additionalProperties === "object";
    for (const [k, v] of Object.entries(value)) {
      if (k in props) compare(spec, props[k], v, at ? `${at}.${k}` : k, f, depth + 1);
      else if (Object.keys(props).length > 0 && !open) {
        f.undocumentedFields++;
        if (f.undocumentedFields <= 3) f.examples.push(`${at ? `${at}.` : ""}${k}: not in spec`);
      }
    }
  }
}

async function probe(api, spec, c) {
  const row = { api: api.id, title: api.title, official: !api.unofficial, endpoint: c.path, url: c.url };
  let res;
  try {
    res = await get(c.url, 15_000);
  } catch (err) {
    const code = String(err.cause?.code ?? err.name ?? err);
    return { ...row, outcome: "unreachable", host_gone: code === "ENOTFOUND", error: code };
  }
  const doc = documented(spec, c.op, res.status);
  const f = { typeMismatches: 0, nullNotAllowed: 0, missingRequired: 0, enumViolations: 0, undocumentedFields: 0, examples: [] };
  let contentTypeMismatch = false;
  let jsonBody = false;
  if (doc.documented && doc.schema) {
    if (!res.contentType.includes("json")) contentTypeMismatch = true;
    else {
      try {
        compare(spec, doc.schema, JSON.parse(res.text), "", f);
        jsonBody = true;
      } catch {
        contentTypeMismatch = true; // says JSON, isn't
      }
    }
  }
  const authRequired = res.status === 401 || res.status === 403;
  const gone = res.status === 404 || res.status === 410;
  const contractBreaks = f.typeMismatches + f.nullNotAllowed + f.missingRequired + f.enumViolations;
  return {
    ...row,
    outcome: "answered",
    status: res.status,
    status_documented: doc.documented && !doc.viaDefault,
    status_only_via_default: doc.documented && doc.viaDefault === true,
    auth_required_undeclared: authRequired,
    endpoint_gone: gone,
    content_type: res.contentType,
    content_type_mismatch: contentTypeMismatch,
    json_compared: jsonBody,
    type_mismatches: f.typeMismatches,
    null_not_allowed: f.nullNotAllowed,
    missing_required: f.missingRequired,
    enum_violations: f.enumViolations,
    undocumented_fields: f.undocumentedFields,
    contract_disagreement: !doc.documented || doc.viaDefault || contentTypeMismatch || contractBreaks > 0,
    any_disagreement: !doc.documented || doc.viaDefault || contentTypeMismatch || contractBreaks > 0 || f.undocumentedFields > 0,
    examples: f.examples.slice(0, 6).join(" | "),
  };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

/** "github.com:api.github.com" → "github.com"; "api.example.co" → "example.co". */
function providerDomain(id) {
  return id.split(":")[0].split(".").slice(-2).join(".");
}

// ---------------------------------------------------------------------------

const list = JSON.parse((await get("https://api.apis.guru/v2/list.json", 60_000)).text);
const apis = Object.entries(list)
  .map(([id, a]) => {
    const v = a.versions[a.preferred];
    return { id, title: v.info?.title ?? id, unofficial: v.info?.["x-unofficialSpec"] === true, specUrl: v.swaggerUrl };
  })
  .filter((a) => a.specUrl)
  .sort((a, b) => Number(a.unofficial) - Number(b.unofficial) || a.id.localeCompare(b.id));

const rows = [];
const answeredApis = new Set();
const triedDomains = new Set();
let specsChecked = 0;
for (let start = 0; start < apis.length && answeredApis.size < TARGET; start += CONCURRENCY * 4) {
  const batch = apis.slice(start, start + CONCURRENCY * 4);
  const found = await pool(batch, CONCURRENCY, async (api) => {
    try {
      const spec = JSON.parse((await get(api.specUrl, 20_000)).text);
      specsChecked++;
      return { api, spec, cands: candidates(spec) };
    } catch {
      return { api, spec: null, cands: [] };
    }
  });
  const withCands = [];
  for (const x of found.filter((x) => x.cands.length > 0)) {
    const d = providerDomain(x.api.id);
    if (triedDomains.has(d)) continue;
    triedDomains.add(d);
    withCands.push(x);
  }
  const results = await pool(withCands, CONCURRENCY, async ({ api, spec, cands }) => {
    const out = [];
    for (const c of cands) out.push(await probe(api, spec, c));
    return out;
  });
  for (const r of results.flat()) {
    if (answeredApis.size >= TARGET && !answeredApis.has(r.api)) continue;
    r.provider_domain = providerDomain(r.api);
    rows.push(r);
    if (r.outcome === "answered") answeredApis.add(r.api);
  }
  console.error(`checked ${specsChecked} specs, ${answeredApis.size} APIs answered`);
}

const answered = rows.filter((r) => r.outcome === "answered");
const triedApis = new Set(rows.map((r) => r.api));
const unreachableApis = [...triedApis].filter((a) => rows.filter((r) => r.api === a).every((r) => r.outcome !== "answered"));
const live = answered.filter((r) => !r.auth_required_undeclared && !r.endpoint_gone);
const ok2xx = answered.filter((r) => r.status >= 200 && r.status < 300);
const share = (xs, f) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 1000) / 10 : 0);
const summary = {
  generated: new Date().toISOString(),
  specs_checked: specsChecked,
  apis_answered: answeredApis.size,
  official_apis_answered: new Set(answered.filter((r) => r.official).map((r) => r.api)).size,
  endpoints_probed: rows.length,
  endpoints_answered: answered.length,
  endpoints_unreachable: rows.length - answered.length,
  pct_endpoints_any_disagreement: share(answered, (r) => r.any_disagreement),
  pct_endpoints_contract_disagreement: share(answered, (r) => r.contract_disagreement),
  pct_apis_any_disagreement: Math.round((new Set(answered.filter((r) => r.any_disagreement).map((r) => r.api)).size / Math.max(1, answeredApis.size)) * 1000) / 10,
  apis_tried: triedApis.size,
  apis_unreachable: unreachableApis.length,
  apis_host_gone: unreachableApis.filter((a) => rows.some((r) => r.api === a && r.host_gone)).length,
  pct_endpoints_gone_404_410: share(answered, (r) => r.endpoint_gone),
  pct_status_undocumented: share(answered, (r) => !r.status_documented),
  pct_live_status_undocumented: share(live, (r) => !r.status_documented),
  pct_auth_required_undeclared: share(answered, (r) => r.auth_required_undeclared),
  pct_content_type_mismatch: share(answered, (r) => r.content_type_mismatch),
  of_2xx_json_compared: ok2xx.filter((r) => r.json_compared).length,
  pct_2xx_type_or_null_mismatch: share(ok2xx.filter((r) => r.json_compared), (r) => r.type_mismatches + r.null_not_allowed > 0),
  pct_2xx_missing_required: share(ok2xx.filter((r) => r.json_compared), (r) => r.missing_required > 0),
  pct_2xx_enum_violation: share(ok2xx.filter((r) => r.json_compared), (r) => r.enum_violations > 0),
  pct_2xx_undocumented_fields: share(ok2xx.filter((r) => r.json_compared), (r) => r.undocumented_fields > 0),
};
const cols = [
  "api", "provider_domain", "title", "official", "endpoint", "url", "outcome", "status", "status_documented", "status_only_via_default", "auth_required_undeclared",
  "endpoint_gone", "host_gone", "content_type", "content_type_mismatch", "json_compared", "type_mismatches", "null_not_allowed", "missing_required", "enum_violations",
  "undocumented_fields", "contract_disagreement", "any_disagreement", "examples", "error",
];
mkdirSync(OUT, { recursive: true });
writeFileSync(
  path.join(OUT, "observatory.csv"),
  [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replaceAll('"', '""')}"`).join(","))].join("\n") + "\n",
);
writeFileSync(path.join(OUT, "observatory-summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.error(JSON.stringify(summary, null, 2));
