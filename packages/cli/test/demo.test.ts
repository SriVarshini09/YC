import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeApiLock } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { run, scan } from "shapi";

const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "demo-ts");
const lockFile = path.join(demo, "api.lock");
const deployLine = readFileSync(path.join(demo, "src", "deploy.ts"), "utf8").split("\n").findIndex((l) => l.includes("const res = await fetch(")) + 1;

describe("demo: shapi scan fixtures/demo-ts", () => {
  it("flags the GitHub workflow_dispatch call site as affected by the 204 to 200 advisory, with file:line, in under 10 seconds", () => {
    const started = performance.now();
    const outcome = scan(demo, { now: "2026-10-21" });
    expect(performance.now() - started).toBeLessThan(10_000);

    const [first] = outcome.match.affected;
    expect(first?.advisory.id).toBe("github-workflow-dispatch-204-to-200");
    expect(first?.advisory.severity).toBe("critical");
    expect(first?.callSite).toMatchObject({
      file: "src/deploy.ts",
      line: deployLine,
      provider: "github",
      method: "POST",
      endpoint: "/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches",
    });
    expect(first?.callSite.surface.statusCodes).toEqual([204]);
    expect(outcome.exitCode).toBe(1);
  });

  it("lints a retired model id kept in a constant no API call uses, and nothing else (S-06)", () => {
    const { lint } = scan(demo, { now: "2026-10-21" });
    expect(lint.map((l) => `${l.file}:${l.line} ${l.kind} ${l.name} ${l.advisoryId}`)).toEqual(["src/summaries.ts:3 model claude-sonnet-4-5 anthropic-claude-sonnet-4-5-retirement"]);
  });

  it("also flags QuickBooks and the HubSpot deadline, finds Stripe, and leaves the .ok-only GitHub call unflagged", () => {
    const { match, lock } = scan(demo, { now: "2026-10-21" });
    expect(match.affected.map((f) => `${f.advisory.id} ${f.callSite.file}`)).toEqual([
      "github-workflow-dispatch-204-to-200 src/deploy.ts",
      "quickbooks-minorversion-below-75-ignored src/accounting.ts",
      "hubspot-pipelines-v1-sunset src/crm.ts",
    ]);
    expect(match.upcoming.map((u) => u.advisory.id)).toEqual(["hubspot-pipelines-v1-sunset"]);
    expect(lock.providers.map((p) => p.id)).toEqual(["github", "hubspot", "quickbooks", "stripe"]);
    const stripe = lock.callSites.find((c) => c.provider === "stripe");
    expect(stripe).toMatchObject({ kind: "sdk", operation: "customers.create", endpoint: "/v1/customers" });
    expect(stripe?.surface.headers).toEqual([{ name: "stripe-version", value: "2024-06-20" }]);
    expect(lock.callSites.filter((c) => c.file === "src/deploy.ts" && !match.affected.some((f) => f.callSite.id === c.id))).toHaveLength(1);
  });

  it("prints the finding with file:line in the text report", async () => {
    let stdout = "";
    const code = await run(["node", "shapi", "scan", demo, "--now", "2026-10-21"], { stdout: (s) => (stdout += s), stderr: () => {} });
    expect(code).toBe(1);
    expect(stdout).toMatch(new RegExp(String.raw`CRITICAL\s+src/deploy\.ts:${deployLine}\s+POST /repos/`));
    expect(stdout).toContain("why: compares the response status to 204");
  });

  it("matches the committed fixtures/demo-ts/api.lock (UPDATE_LOCK=1 rewrites it)", () => {
    const { lock } = scan(demo, { now: "2026-10-21" });
    const text = serializeApiLock(lock);
    if (process.env.UPDATE_LOCK) writeFileSync(lockFile, text);
    expect(readFileSync(lockFile, "utf8")).toBe(text);
    expect(extractCallSites(demo).callSites).toHaveLength(lock.callSites.length);
  });
});
