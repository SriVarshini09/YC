import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "@shapi/mcp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-mcp-"));
const demo = path.join(tmp, "demo");
cpSync(path.join(root, "fixtures", "demo-ts"), demo, { recursive: true });

const delivered: { repo: string; branch: string }[] = [];
let client: Client;

async function connect(opts: ServerOptions) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(opts).connect(serverSide);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientSide);
  return c;
}

beforeAll(async () => {
  client = await connect({
    cwd: demo,
    advisoriesDir: path.join(root, "advisories"),
    db: path.join(tmp, "none.db"),
    deliver: async (repo, _files, meta) => {
      delivered.push({ repo, branch: meta.branch });
      return { url: "https://github.com/acme/demo/pull/9", number: 9, branch: meta.branch, commit: "c" };
    },
  });
});
afterAll(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0]!.text;
const data = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse(text(r).slice(text(r).indexOf("\n\n") + 2));

describe("shapi MCP server", () => {
  it("lists the four tools with read-only hints on the first three", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["scan", "advisories", "impact", "apply_fix"]);
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(["scan", "advisories", "impact"]);
    expect(tools.find((t) => t.name === "apply_fix")?.inputSchema.properties).toHaveProperty("mode");
  });

  it("scan reports the affected GitHub call site with file:line and reasons", async () => {
    const r = await client.callTool({ name: "scan", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("CRITICAL src/deploy.ts:13 POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches");
    const d = data(r);
    expect(d.providers.map((p: { id: string }) => p.id)).toEqual(["github", "hubspot", "quickbooks", "stripe"]);
    expect(d.affected[0]).toMatchObject({ advisory: "github-workflow-dispatch-204-to-200", file: "src/deploy.ts", line: 13, reasons: ["compares the response status to 204"] });
  });

  it("advisories filters by provider and marks auto-fixable ones", async () => {
    const r = await client.callTool({ name: "advisories", arguments: { provider: "github" } });
    expect(text(r)).toContain("[github-workflow-dispatch-204-to-200] critical github");
    expect(text(r)).toContain("auto-fix recipe");
    expect(data(r)).toHaveLength(1);
  });

  it("impact explains affected and exposed call sites for one advisory", async () => {
    const r = await client.callTool({ name: "impact", arguments: { advisoryId: "github-workflow-dispatch-204-to-200" } });
    expect(text(r)).toContain("Affected: src/deploy.ts:13 (compares the response status to 204).");
    expect(text(r)).toContain("A deterministic recipe (status-code-accept-set) can apply it");
    const missing = await client.callTool({ name: "impact", arguments: { advisoryId: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("apply_fix dry-run returns the verified diff without touching files", async () => {
    const r = await client.callTool({ name: "apply_fix", arguments: { advisoryId: "github-workflow-dispatch-204-to-200" } });
    expect(text(r)).toContain("1 of 1 affected call site(s) fixed (dry-run).");
    const [outcome] = data(r);
    expect(outcome).toMatchObject({ status: "fixed", method: "recipe", callSite: "src/deploy.ts:13" });
    expect(outcome.diff).toContain("-  if (res.status !== 204) {");
    expect(outcome.diff).toContain("+  if (![200, 204].includes(res.status)) {");
    expect(outcome.diff).toContain("+++ b/test/shapi/github-workflow-dispatch-204-to-200.test.ts");
    expect(readFileSync(path.join(demo, "src", "deploy.ts"), "utf8")).toContain("res.status !== 204");
  }, 120_000);

  it("apply_fix write edits the repo, after which scan finds nothing affected", async () => {
    const r = await client.callTool({ name: "apply_fix", arguments: { advisoryId: "github-workflow-dispatch-204-to-200", mode: "write" } });
    expect(data(r)[0].status).toBe("fixed");
    expect(readFileSync(path.join(demo, "src", "deploy.ts"), "utf8")).toContain("![200, 204].includes(res.status)");
    const again = await client.callTool({ name: "impact", arguments: { advisoryId: "github-workflow-dispatch-204-to-200" } });
    expect(text(again)).toContain("Affected: none.");
  }, 120_000);

  it("apply_fix pr without a GitHub remote is an error, not a crash", async () => {
    const r = await client.callTool({ name: "apply_fix", arguments: { mode: "pr" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("--pr needs a GitHub repository");
    expect(delivered).toEqual([]);
  });
});
