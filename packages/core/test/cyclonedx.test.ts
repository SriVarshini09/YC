import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { ApiLockSchema, apiLockToCycloneDx } from "@shapi/core";

// Execution plan S-02: api.lock as a CycloneDX 1.7 SaaSBOM, validated against the official schema.
const here = path.dirname(fileURLToPath(import.meta.url));
const schemas = path.join(here, "fixtures", "cyclonedx");
const load = (f: string) => JSON.parse(readFileSync(path.join(schemas, f), "utf8"));
const lock = ApiLockSchema.parse(JSON.parse(readFileSync(path.join(here, "..", "..", "..", "fixtures", "demo-ts", "api.lock"), "utf8")));
const sbom = apiLockToCycloneDx(lock, { name: "acme/demo", sha: "0123456789abcdef0123456789abcdef01234567", toolVersion: "0.3.1" }) as {
  serialNumber: string;
  services: { "bom-ref": string; name: string; endpoints?: string[]; properties: { name: string; value: string }[] }[];
  components: { "bom-ref": string; name: string; evidence: { occurrences: { location: string; line: number; symbol?: string }[] } }[];
  metadata: { component: { version?: string }; properties: { name: string; value: string }[] };
};

describe("CycloneDX SaaSBOM export (S-02)", () => {
  it("validates against the CycloneDX 1.7 JSON schema", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const f of ["spdx.schema.json", "jsf-0.82.schema.json", "cryptography-defs.schema.json"]) ajv.addSchema(load(f));
    const validate = ajv.compile(load("bom-1.7.schema.json"));
    expect(validate(sbom), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
  });

  it("lists each provider as a service with its endpoints, and each call site as evidence", () => {
    const providers = [...new Set(lock.callSites.flatMap((s) => (s.provider ? [s.provider] : [])))].sort();
    expect(sbom.services.map((s) => s["bom-ref"])).toEqual(providers.map((p) => `service:${p}`));
    const github = sbom.services.find((s) => s["bom-ref"] === "service:github")!;
    expect(github.endpoints).toContain("https://api.github.com/repos/%7Bowner%7D/%7Brepo%7D/actions/workflows/%7Bworkflow%7D/dispatches");
    expect(github.properties).toContainEqual({ name: "shapi:operation", value: "POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches" });
    const occurrences = sbom.components.flatMap((c) => c.evidence.occurrences);
    expect(occurrences).toHaveLength(lock.callSites.filter((s) => s.provider).length);
    expect(occurrences).toContainEqual(expect.objectContaining({ location: "src/deploy.ts", symbol: "POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches" }));
    expect(sbom.metadata.component.version).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(sbom.metadata.properties.every((p) => p.name.startsWith("shapi:"))).toBe(true);
  });

  it("is the same bytes for the same lock, and a new serial number for a different commit", () => {
    const again = apiLockToCycloneDx(lock, { name: "acme/demo", sha: "0123456789abcdef0123456789abcdef01234567", toolVersion: "0.3.1" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(sbom));
    expect(sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((apiLockToCycloneDx(lock, { name: "acme/demo", sha: "f".repeat(40) }) as { serialNumber: string }).serialNumber).not.toBe(sbom.serialNumber);
  });
});
