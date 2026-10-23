import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { RECIPES, generateContractTest, repairCallSite, runRecipe } from "@shapi/repair";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisories = loadAdvisories(path.join(root, "advisories"));
const byId = (id: string) => advisories.find((a) => a.id === id)!;
const now = new Date("2026-10-23");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-applyfix-"));
const sandboxes: string[] = [];
afterAll(() => {
  for (const d of [tmp, ...sandboxes]) rmSync(d, { recursive: true, force: true });
});

let n = 0;
/** A one-file repo; returns the call sites `advisory` affects. */
function repo(source: string, advisory: Advisory, file = "src/app.ts"): { dir: string; sites: LockedCallSite[] } {
  const dir = path.join(tmp, `r${++n}`);
  mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  cpSync(path.join(root, "fixtures", "demo-ts", "package.json"), path.join(dir, "package.json"));
  writeFileSync(path.join(dir, file), source);
  const sites = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory], { now }).affected.map((f) => f.callSite);
  return { dir, sites };
}

async function repairOnly(dir: string, advisory: Advisory, site: LockedCallSite) {
  const result = await repairCallSite({ repoDir: dir, advisory, callSite: site, recipes: RECIPES });
  if (result.sandbox) sandboxes.push(result.sandbox);
  return result;
}

describe("apply-fix: request changes", () => {
  it("fixes the demo's QuickBooks minorversion, test-first, with no recorded responses", async () => {
    const advisory = byId("quickbooks-minorversion-below-75-ignored");
    const demo = path.join(tmp, "demo");
    cpSync(path.join(root, "fixtures", "demo-ts"), demo, { recursive: true });
    const [site] = matchAdvisories(createApiLock(extractCallSites(demo), "test"), [advisory], { now }).affected.map((f) => f.callSite);
    const result = await repairOnly(demo, advisory, site!);
    expect(result.status).toBe("fixed");
    expect(result.baseline?.passed).toBe(false);
    expect(result.changes.map((c) => c.file)).toEqual(["src/accounting.ts", "test/shapi/quickbooks-minorversion-below-75-ignored.test.ts"]);
    expect(result.changes[0]!.after).toContain("&minorversion=75`");
    expect(result.changes[0]!.after.replace("minorversion=75", "minorversion=65")).toBe(result.changes[0]!.before);
    expect(result.test!.content).toContain("Number(url.searchParams.get(\"minorversion\")) < 75");
  }, 60_000);

  it("moves a Graph API version kept in a base URL constant", async () => {
    const advisory = byId("meta-graph-v21-sunset");
    const { dir, sites } = repo(
      `const GRAPH = "https://graph.facebook.com/v21.0";

export async function pageName(pageId: string, token: string) {
  const res = await fetch(\`\${GRAPH}/\${pageId}?fields=name\`, { headers: { Authorization: \`Bearer \${token}\` } });
  if (!res.ok) throw new Error(\`graph failed with \${res.status}\`);
  const body = await res.json();
  return body.name;
}
`,
      advisory,
    );
    expect(sites).toHaveLength(1);
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("fixed");
    expect(result.changes[0]!.after).toContain('const GRAPH = "https://graph.facebook.com/v26.0";');
    expect(result.changes[0]!.notes).toEqual(['src/app.ts:1 `"https://graph.facebook.com/v21.0"` → `"https://graph.facebook.com/v26.0"`']);
  }, 60_000);

  it("moves a retired HubSpot path and reads the renamed id fields, keeping the old names as a fallback", async () => {
    const advisory = byId("hubspot-pipelines-v1-sunset");
    const { dir, sites } = repo(
      `export async function stageIds(token: string) {
  const res = await fetch("https://api.hubapi.com/crm-pipelines/v1/pipelines/deals", { headers: { Authorization: \`Bearer \${token}\` } });
  if (!res.ok) throw new Error(\`hubspot failed with \${res.status}\`);
  const body = await res.json();
  return body.results.map((p: { pipelineId: string; stages: { stageId: string }[] }) => [p.pipelineId, p.stages.map((s) => s.stageId)]);
}
`,
      advisory,
    );
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("fixed");
    const after = result.changes[0]!.after;
    expect(after).toContain('"https://api.hubapi.com/crm/pipelines/2026-09/deals"');
    expect(after).toContain("[(p.id ?? p.pipelineId), p.stages.map((s) => (s.id ?? s.stageId))]");
  }, 60_000);

  it("sets a version header and an axios params value", () => {
    const advisory: Advisory = {
      ...byId("quickbooks-minorversion-below-75-ignored"),
      id: "test-header-and-params",
      trigger: { query: [{ name: "minorversion", below: 75 }] },
      fix: { query: { name: "minorversion", value: "75" }, header: { name: "Intuit-Version", value: "75" } },
    };
    const source = `import axios from "axios";

export async function invoices(realmId: string) {
  const res = await axios.get(\`https://quickbooks.api.intuit.com/v3/company/\${realmId}/query\`, {
    params: { query: "select * from Invoice", minorversion: 65 },
    headers: { "intuit-version": "65", Accept: "application/json" },
  });
  return res.data.QueryResponse;
}
`;
    const { sites } = repo(source, advisory);
    const outcome = runRecipe(RECIPES, advisory, sites[0]!, source);
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.change.after).toContain('params: { query: "select * from Invoice", minorversion: 75 }');
    expect(outcome.change.after).toContain('headers: { "intuit-version": "75", Accept: "application/json" }');
  });
});

describe("apply-fix: response renames", () => {
  it("reads HubSpot's folderIdV2, verified by returning the same result for the old and the new response", async () => {
    const advisory = byId("hubspot-marketing-emails-folderid-removed");
    const { dir, sites } = repo(
      `export async function emailFolders(token: string) {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  return body.results.map((e: { folderId: string }) => e.folderId);
}
`,
      advisory,
    );
    expect(sites).toHaveLength(1);
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("fixed");
    expect(result.changes[0]!.after).toContain("(e.folderIdV2 ?? e.folderId)");
    expect(result.test!.content).toContain("returns the same result for the old and the new response");
  }, 60_000);

  it("accepts Stripe's renamed ui_mode values wherever the code compares them", async () => {
    const advisory = byId("stripe-checkout-session-ui-mode-values-renamed");
    const source = `export async function checkoutKind(id: string, key: string) {
  const res = await fetch(\`https://api.stripe.com/v1/checkout/sessions/\${id}\`, { headers: { Authorization: \`Bearer \${key}\` } });
  const session = await res.json();
  if (session.ui_mode === "embedded") return "in-page";
  switch (session.ui_mode) {
    case "hosted":
      return "redirect";
    default:
      return "other";
  }
}
`;
    const { dir, sites } = repo(source, advisory);
    expect(sites).toHaveLength(1);
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("fixed");
    const after = result.changes[0]!.after;
    expect(after).toContain('if (["embedded","embedded_page"].includes(session.ui_mode)) return "in-page";');
    expect(after).toContain('case "hosted_page":\n    case "hosted":');
  }, 60_000);

  it("reports an already-correct call site instead of changing it", async () => {
    const advisory = byId("hubspot-marketing-emails-folderid-removed");
    const source = `export async function emailFolders(token: string) {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  return body.results.map((e: { folderId?: string; folderIdV2?: string }) => e.folderIdV2 ?? e.folderId);
}
`;
    const { dir, sites } = repo(source, advisory);
    const test = generateContractTest({ callSite: sites[0]!, advisory, sourceText: source });
    expect(test.status).toBe("generated");
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("already-handled");
    expect(readFileSync(path.join(dir, "src", "app.ts"), "utf8")).toBe(source);
  }, 60_000);
});
