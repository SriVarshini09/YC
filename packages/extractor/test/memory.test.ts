import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Node } from "ts-morph";
import { extractCallSites } from "@shapi/extractor";

// ts-morph's getDescendants(), getDescendantsOfKind() and getChildren() build and keep a node for every
// token of a file. A scan that used them on every file kept ~150 MB more for a 2 MB repository and ran
// the 512 MB worker out of memory. The extractor walks with forEachDescendant() instead.
const TOKEN_BUILDING = ["getDescendants", "getDescendantsOfKind", "getChildren", "getChildrenOfKind", "getFirstDescendantByKind", "getFirstChildByKind"] as const;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("extractor memory", () => {
  it("never asks ts-morph for token children while scanning", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-memory-"));
    dirs.push(dir);
    const files: Record<string, string> = {
      "src/client.ts": `import OpenAI from "openai";\nexport const openai = new OpenAI();\n`,
      "src/chat.ts": `import { openai } from "./client";
const BASE = "https://api.hubapi.com";
export async function run(token: string) {
  const res = await fetch(\`\${BASE}/crm-pipelines/v1/pipelines/deals\`, { headers: { Authorization: "Bearer " + token } });
  if (res.status === 204) return [];
  const body = await res.json();
  await openai.chat.completions.create({ model: "gpt-4o-2024-08-06", messages: [] });
  return body.results.map((p: { stages: unknown[] }) => p.stages);
}
const helper = { url: "https://api.stripe.com/v1/charges" };
export { helper };
`,
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }

    const proto = Node.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originals = Object.fromEntries(TOKEN_BUILDING.map((name) => [name, proto[name]!]));
    const calls: string[] = [];
    for (const name of TOKEN_BUILDING) {
      proto[name] = function (this: unknown, ...args: unknown[]) {
        calls.push(name);
        return originals[name]!.apply(this, args);
      };
    }
    try {
      expect(extractCallSites(dir).callSites.length).toBeGreaterThanOrEqual(3);
    } finally {
      for (const name of TOKEN_BUILDING) proto[name] = originals[name]!;
    }
    expect([...new Set(calls)]).toEqual([]);
  });
});
