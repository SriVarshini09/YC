import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiLockSchema, createApiLock, serializeApiLock } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("extractor output as api.lock", () => {
  it("validates against the schema and is deterministic across runs", () => {
    for (const name of ["calls", "surface"]) {
      const first = serializeApiLock(createApiLock(extractCallSites(path.join(fixtures, name)), "shapi test"));
      const second = serializeApiLock(createApiLock(extractCallSites(path.join(fixtures, name)), "shapi test"));
      expect(second).toBe(first);
      expect(() => ApiLockSchema.parse(JSON.parse(first))).not.toThrow();
    }
  });
});
