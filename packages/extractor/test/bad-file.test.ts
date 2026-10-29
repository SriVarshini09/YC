import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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

// Make building a file's symbol table throw: the client collector looks up every constructed package.
vi.mock("@shapi/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shapi/core")>();
  return {
    ...actual,
    providerForPackage: (name: string) => {
      if (name === "boom-sdk") throw new Error("client collector failed");
      return actual.providerForPackage(name);
    },
  };
});

const dirs: string[] = [];
function write(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-badfile-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("a file the extractor fails on", () => {
  it("is listed as skipped while the other files are still scanned", () => {
    const dir = write({
      "package.json": JSON.stringify({ dependencies: { stripe: "^17.0.0" } }),
      // SDK chains named like Object.prototype members are not endpoints: not recorded, and no crash
      "src/billing.ts": `import Stripe from "stripe";
const stripe = new Stripe("sk_test_x");
console.log(stripe.toString(), stripe.constructor(), stripe.hasOwnProperty("x"), stripe.customers.valueOf());
export const customer = () => stripe.customers.create({ email: "a@b.c" });
`,
      "src/boom.ts": `export const repo = () => fetch("https://api.github.com/repos/acme/web");
`,
      "src/ok.ts": `export const user = () => fetch("https://api.github.com/user");
`,
    });
    const result = extractCallSites(dir);
    expect(result.skipped).toEqual([{ file: "src/boom.ts", reason: "surface pass failed" }]);
    expect(result.callSites.some((s) => s.file === "src/boom.ts")).toBe(false);
    expect(result.callSites.map((s) => `${s.file} ${s.operation ?? s.endpoint} ${s.endpoint}`)).toEqual([
      "src/billing.ts customers.create /v1/customers",
      "src/ok.ts /user /user",
    ]);
    expect(result.filesScanned).toBe(2);
  });

  it("is skipped itself when another file imports a client from it, and the importer keeps its other calls", () => {
    const dir = write({
      "package.json": JSON.stringify({ dependencies: { stripe: "^17.0.0" } }),
      // sorted before src/client.ts, so its import is followed before client.ts has its own turn
      "src/a-use.ts": `import { stripe } from "./client";
export const list = () => stripe.customers.list();
export const user = () => fetch("https://api.github.com/user");
`,
      "src/client.ts": `import Stripe from "stripe";
import Boom from "boom-sdk";
const boom = new Boom();
export const stripe = new Stripe("sk_test_x");
export const charges = () => stripe.charges.list();
`,
    });
    const result = extractCallSites(dir);
    expect(result.skipped).toEqual([{ file: "src/client.ts", reason: "client collector failed" }]);
    expect(result.callSites.map((s) => `${s.file} ${s.endpoint}`)).toEqual(["src/a-use.ts /user"]);
    expect(result.filesScanned).toBe(1);
  });
});
