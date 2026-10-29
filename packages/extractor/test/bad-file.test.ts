import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { extractCallSites } from "@shapi/extractor";

// Make the response-surface pass throw for one file, standing in for any extractor bug on odd code.
vi.mock("../src/surface", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/surface")>();
  return {
    ...actual,
    addResponseSurface: (found: Parameters<typeof actual.addResponseSurface>[0]) => {
      if (found.site.file === "src/boom.ts") throw new Error("surface pass failed");
      actual.addResponseSurface(found);
    },
  };
});

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { stripe: "^17.0.0" } }),
  // SDK chains named like Object.prototype members are not endpoints, and must not crash the scan
  "src/billing.ts": `import Stripe from "stripe";
const stripe = new Stripe("sk_test_x");
console.log(stripe.toString(), stripe.constructor(), stripe.hasOwnProperty("x"));
export const customer = () => stripe.customers.create({ email: "a@b.c" });
`,
  "src/boom.ts": `export const repo = () => fetch("https://api.github.com/repos/acme/web");
`,
  "src/ok.ts": `export const user = () => fetch("https://api.github.com/user");
`,
};

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "shapi-badfile-"));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a file the extractor fails on", () => {
  it("is listed as skipped while the other files are still scanned", () => {
    const result = extractCallSites(dir);
    expect(result.skipped).toEqual([{ file: "src/boom.ts", reason: "surface pass failed" }]);
    expect(result.callSites.some((s) => s.file === "src/boom.ts")).toBe(false);
    expect(result.callSites.map((s) => `${s.file} ${s.operation ?? s.endpoint} ${s.endpoint}`)).toEqual([
      "src/billing.ts toString null",
      "src/billing.ts constructor null",
      "src/billing.ts hasOwnProperty null",
      "src/billing.ts customers.create /v1/customers",
      "src/ok.ts /user /user",
    ]);
    expect(result.filesScanned).toBe(2);
  });
});
