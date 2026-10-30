import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, pathUnresolved, type MatchResult } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// Execution plan A-03: a call site whose endpoint SHAPI cannot tell is reported as unresolved, never guessed.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-30T12:00:00Z");
const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-unresolved-"));
let match: MatchResult;

beforeAll(() => {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "api.ts"),
    `export async function call(path: string, token: string) {
  const github = await fetch(\`https://api.github.com\${path}\`, { method: "POST", headers: { authorization: token } });
  const graph = await fetch(\`https://graph.facebook.com/\${path}\`);
  const pinned = await fetch(\`https://graph.facebook.com/v21.0/\${path}\`);
  const unknown = await fetch(buildUrl(path));
  if (github.status === 204) return [graph, pinned, unknown];
}
declare function buildUrl(p: string): string;
`,
  );
  match = matchAdvisories(createApiLock(extractCallSites(dir), "test"), advisories, { now });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const at = (line: number) => (f: { callSite: { line: number } }) => f.callSite.line === line;

describe("unresolved call sites (A-03)", () => {
  it("knows a path built entirely at runtime from one it can place", () => {
    expect(pathUnresolved(null)).toBe(true);
    expect(pathUnresolved("/{path}")).toBe(true);
    expect(pathUnresolved("/{a}/{b}")).toBe(true);
    expect(pathUnresolved("/")).toBe(false);
    expect(pathUnresolved("/v21.0/{path}")).toBe(false);
    expect(pathUnresolved("/{page_id}/feed")).toBe(false);
  });

  it("keeps the provider of a host written straight before a runtime path", () => {
    const lock = createApiLock(extractCallSites(dir), "test");
    expect(lock.callSites.find((s) => s.line === 2)).toMatchObject({ provider: "github", host: "api.github.com", endpoint: "/{path}", resolved: false });
    expect(lock.callSites.find((s) => s.line === 3)).toMatchObject({ provider: "meta-graph", endpoint: "/{path}", resolved: false });
  });

  it("reports a runtime-built URL as unresolved, not exposed or affected, with the advisories it could reach", () => {
    for (const line of [2, 3]) {
      expect(match.affected.some(at(line))).toBe(false);
      expect(match.exposed.some(at(line))).toBe(false);
      expect(match.possible.some(at(line))).toBe(false);
    }
    const github = match.unresolved.find(at(2))!;
    expect(github.reason).toBe("builds the whole path at runtime (POST /{path}), so SHAPI cannot tell which endpoint it calls");
    // Only GitHub advisories its POST could reach.
    expect(github.advisories).toContain("github-workflow-dispatch-204-to-200");
    expect(github.advisories.every((id) => advisories.find((a) => a.id === id)!.provider === "github")).toBe(true);
    expect(match.unresolved.find(at(3))!.advisories).toContain("meta-graph-v21-sunset");
  });

  it("still matches a path it can place, and says nothing of a URL with no provider", () => {
    expect(match.affected.some((f) => at(4)(f) && f.advisory.id === "meta-graph-v21-sunset")).toBe(true);
    expect(match.unresolved.some(at(4))).toBe(false);
    expect(match.unresolved.some(at(5))).toBe(false);
  });
});
