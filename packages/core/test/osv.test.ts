import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { OSV_BASE_URL, advisoryToOsv, createApiLock, loadAdvisories, matchAdvisories, matchToOpenVex, osvId, type Advisory, type CallSite, type Surface } from "@shapi/core";

// Execution plan S-03: advisories as OSV records and verdicts as OpenVEX, validated against the official schemas.
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(path.join(here, "fixtures", f), "utf8"));
const advisories = loadAdvisories(path.join(here, "..", "..", "..", "advisories"));

describe("OSV export (S-03)", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(load("osv/schema.json"));

  it("turns every advisory into a record the OSV schema accepts", () => {
    expect(advisories.length).toBeGreaterThan(50);
    for (const a of advisories) {
      const record = advisoryToOsv(a, { modified: "2026-10-30T00:00:00Z" });
      expect(validate(record), `${a.id}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
  });

  it("publishes every advisory at shapi.dev/osv/<id>.json, in sync (UPDATE_OSV=1 rewrites them)", () => {
    const dir = path.resolve(here, "..", "..", "..", "site", "public", "osv");
    const files = new Map(advisories.map((a) => [`${a.id}.json`, `${JSON.stringify(advisoryToOsv(a), null, 2)}\n`]));
    const index = advisories.map((a) => ({ id: osvId(a.id), modified: (advisoryToOsv(a) as { modified: string }).modified, url: `${OSV_BASE_URL}/${a.id}.json` }));
    files.set("index.json", `${JSON.stringify(index, null, 2)}\n`);
    if (process.env.UPDATE_OSV || !existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of files) writeFileSync(path.join(dir, name), text);
    }
    expect(readdirSync(dir).sort()).toEqual([...files.keys()].sort());
    for (const [name, text] of files) expect(readFileSync(path.join(dir, name), "utf8"), name).toBe(text);
  });

  it("dates a record by the latest date its advisory records", () => {
    const a = advisories[0]!;
    const fetched = { url: "https://example.com", quote: "q", sourceSha256: "0".repeat(64), fetchedAt: "2099-01-02T03:04:05.678Z" };
    expect((advisoryToOsv({ ...a, provenance: [fetched] }) as { modified: string }).modified).toBe("2099-01-02T03:04:05Z");
    expect((advisoryToOsv({ ...a, effectiveDate: "2098-01-01", publishedNotice: null, firstObserved: null, provenance: [] }) as { modified: string }).modified).toBe("2098-01-01T00:00:00Z");
  });

  it("uses an x_ ID, no package, and carries the API details in ecosystem_specific", () => {
    const a = advisories.find((x) => x.status === "verified" && x.publishedNotice)!;
    const record = advisoryToOsv(a) as { id: string; affected: { package?: unknown; ecosystem_specific: Record<string, unknown> }[]; references: { type: string; url: string }[] };
    expect(record.id).toBe(`x_SHAPI-${a.id}`);
    expect(record.affected[0]!.package).toBeUndefined();
    expect(record.affected[0]!.ecosystem_specific).toMatchObject({ provider: a.provider, endpoint: a.endpoint, change_class: a.changeClass, trigger: a.trigger });
    expect(record.references[0]).toEqual({ type: "ADVISORY", url: a.publishedNotice!.url });
    expect(new Set(record.references.map((r) => r.url)).size).toBe(record.references.length);
  });
});

describe("OpenVEX export (S-03)", () => {
  const empty: Surface = { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [] };
  const site = (line: number, endpoint: string, surface: Partial<Surface> = {}): CallSite => ({
    file: "src/api.ts",
    line,
    column: 1,
    provider: "acme",
    kind: "http",
    client: "fetch",
    method: "GET",
    host: "api.acme.dev",
    endpoint,
    resolved: true,
    surface: { ...empty, ...surface },
  });
  const advisory = (id: string, path: string, trigger: Advisory["trigger"]): Advisory => ({
    id,
    provider: "acme",
    title: `t ${id}`,
    summary: "s",
    endpoint: { method: "GET", path },
    changeClass: "field-rename",
    trigger,
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2027-01-01",
    severity: "high",
    migrationNote: `Read the new field (${id}).`,
    sources: ["https://acme.dev/changelog"],
    status: "verified",
  });
  const sites = [site(1, "/v1/orders", { fields: ["total"] }), site(2, "/v1/orders", { fields: ["id"] }), site(3, "/v1/users", { fields: ["id"] }), site(4, "/v1/invoices")];
  const match = matchAdvisories(
    createApiLock({ callSites: sites, declared: [] }, "t"),
    [advisory("acme-orders", "/v1/orders", { fields: ["total"] }), advisory("acme-users", "/v1/users", { fields: ["name"] }), advisory("acme-unused", "/v1/refunds", { any: true })],
    { now: new Date("2026-10-30") },
  );
  const vex = matchToOpenVex(match, [], { repo: "acme/shop", sha: "0123456789abcdef0123456789abcdef01234567", timestamp: "2026-10-30T12:00:00Z", toolVersion: "0.3.1" }) as {
    statements: { vulnerability: { name: string }; status: string; products: { "@id": string; subcomponents: { "@id": string }[] }[]; justification?: string; action_statement?: string }[];
  };

  it("validates against the OpenVEX 0.2.0 schema", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addFormat("iri", true);
    const validate = ajv.compile(load("openvex/openvex_json_schema.json"));
    expect(validate(vex), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it("says affected with the migration note, not_affected for exposed-only, and skips advisories the code never reaches", () => {
    expect(vex.statements.map((s) => `${s.vulnerability.name} ${s.status}`)).toEqual(["x_SHAPI-acme-orders affected", "x_SHAPI-acme-users not_affected"]);
    const [orders, users] = vex.statements;
    expect(orders!.action_statement).toBe("Read the new field (acme-orders).");
    expect(orders!.products[0]!["@id"]).toBe("https://github.com/acme/shop/tree/0123456789abcdef0123456789abcdef01234567");
    expect(orders!.products[0]!.subcomponents).toEqual([{ "@id": "https://github.com/acme/shop/blob/0123456789abcdef0123456789abcdef01234567/src/api.ts#L1" }]);
    expect(users!.justification).toBe("vulnerable_code_not_present");
  });

  it("puts a call SHAPI could not read under investigation", () => {
    const gql = advisory("acme-gql", "/graphql", { graphql: [{ field: "orders" }] });
    const m = matchAdvisories(createApiLock({ callSites: [{ ...site(9, "/graphql"), method: "POST" }], declared: [] }, "t"), [{ ...gql, endpoint: { method: "POST", path: "/graphql" } }], {
      now: new Date("2026-10-30"),
    });
    const doc = matchToOpenVex(m, [gql], { repo: "acme/shop", timestamp: "2026-10-30T12:00:00Z" }) as typeof vex;
    expect(doc.statements.map((s) => s.status)).toEqual(["under_investigation"]);
    expect(doc.statements[0]!.products[0]!.subcomponents[0]!["@id"]).toBe("https://github.com/acme/shop/blob/HEAD/src/api.ts#L9");
  });
});
