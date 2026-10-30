import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { checkKept } from "@shapi/repair";

// Execution plan V-06: a fix may not delete the call or the read of what changed.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const byId = (id: string) => advisories.find((a) => a.id === id)!;
const site = (s: Partial<LockedCallSite>) => ({ id: "0".repeat(12), column: 1, kind: "http", client: "fetch", host: null, resolved: true, ...s }) as LockedCallSite;

describe("checkKept (V-06)", () => {
  it("accepts a path fix that moves the call to the new version", () => {
    const before = `export const media = (id: string) => fetch(\`https://graph.facebook.com/v21.0/\${id}\`);\n`;
    const r = checkKept({
      advisory: byId("meta-graph-v21-sunset"),
      callSite: site({ file: "src/media.ts", line: 1, provider: "meta-graph", method: "GET", endpoint: "/v21.0/{id}" }),
      files: [{ file: "src/media.ts", before, after: before.replace("v21.0", "v26.0") }],
    });
    expect(r).toEqual({ status: "kept", detail: "the change keeps the call to GET /v21.0/{id} and what it reads" });
  });

  it("rejects a change that stops reading the field the advisory is about", () => {
    const advisory: Advisory = { ...byId("github-workflow-dispatch-204-to-200"), trigger: { fields: ["workflow_runs"] }, fix: undefined };
    const before = `export async function latest() {\n  const res = await fetch("https://api.github.com/repos/a/b/actions/runs");\n  const body = await res.json();\n  return body.workflow_runs[0];\n}\n`;
    const callSite = site({ file: "src/runs.ts", line: 2, provider: "github", method: "GET", endpoint: "/repos/a/b/actions/runs" });
    const r = checkKept({ advisory, callSite, files: [{ file: "src/runs.ts", before, after: before.replace("return body.workflow_runs[0];", "return undefined;") }] });
    expect(r).toEqual({ status: "removed", detail: "the change stops reading workflow_runs at GET /repos/a/b/actions/runs" });
    // Reading the renamed field the advisory names is fine.
    const renamed: Advisory = { ...advisory, fix: { fields: [{ from: "workflow_runs", to: "runs" }] } };
    expect(checkKept({ advisory: renamed, callSite, files: [{ file: "src/runs.ts", before, after: before.replace("body.workflow_runs[0]", "body.runs[0]") }] }).status).toBe("kept");
  });

  it("does not guess when it cannot see the call in the changed files alone", () => {
    const before = `import { BASE } from "./config";\nexport const go = () => fetch(\`\${BASE}/repos/a/b/actions/workflows/c/dispatches\`, { method: "POST" });\n`;
    const r = checkKept({
      advisory: byId("github-workflow-dispatch-204-to-200"),
      callSite: site({ file: "src/go.ts", line: 2, provider: "github", method: "POST", endpoint: "/repos/a/b/actions/workflows/c/dispatches" }),
      files: [{ file: "src/go.ts", before, after: "export const go = () => undefined;\n" }],
    });
    expect(r.status).toBe("not-checked");
    expect(r.detail).toContain("SHAPI cannot see the call at src/go.ts:2");
  });
});
