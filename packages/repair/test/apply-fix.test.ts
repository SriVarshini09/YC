import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { RECIPES, generateContractTest, repairAdvisory, repairCallSite, runRecipe, runTestFile } from "@shapi/repair";

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
    expect(result.changes[0]!.notes).toEqual(['` src/app.ts:1 ` ` "https://graph.facebook.com/v21.0" ` → ` "https://graph.facebook.com/v26.0" `']);
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
    // The parameter types do not know the new names yet, so the reads are cast for tsc.
    expect(after).toContain("[((p as any).id ?? p.pipelineId), p.stages.map((s) => ((s as any).id ?? s.stageId))]");
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
    expect(result.changes[0]!.after).toContain("((e as any).folderIdV2 ?? e.folderId)");
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

  it("does not call a function that returns nothing already-handled: there is no result to compare", async () => {
    const advisory = byId("hubspot-marketing-emails-folderid-removed");
    const { dir, sites } = repo(
      `const seen: string[] = [];
export async function syncFolders(token: string): Promise<void> {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  for (const e of body.results) seen.push(e.folderId);
}
`,
      advisory,
    );
    const result = await repairOnly(dir, advisory, sites[0]!);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toBe("syncFolders() returns nothing, so there is no result to compare");
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

describe("repairAdvisory: every call site of an advisory in one change", () => {
  const advisory = byId("quickbooks-minorversion-below-75-ignored");
  const qbo = (fn: string, exported = true) => `${exported ? "export " : ""}async function ${fn}(realmId: string, token: string) {
  const res = await fetch(\`https://quickbooks.api.intuit.com/v3/company/\${realmId}/query?query=x&minorversion=65\`, { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  return body.QueryResponse;
}
`;

  function multiRepo(files: Record<string, string>) {
    const dir = path.join(tmp, `m${++n}`);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    cpSync(path.join(root, "fixtures", "demo-ts", "package.json"), path.join(dir, "package.json"));
    const sites = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory], { now }).affected.map((f) => f.callSite);
    return { dir, sites };
  }

  it("fixes three call sites in two files: each file once, one contract test per call site", async () => {
    const { dir, sites } = multiRepo({ "src/a.ts": qbo("invoices") + "\n" + qbo("bills"), "src/b.ts": qbo("payments") });
    expect(sites).toHaveLength(3);
    const repair = await repairAdvisory({ repoDir: dir, advisory, callSites: sites, recipes: RECIPES });
    if (repair.sandbox) sandboxes.push(repair.sandbox);
    expect(repair.status).toBe("fixed");
    expect(repair.sites.map((s) => `${s.callSite.file}:${s.callSite.line} ${s.result.status}`)).toEqual(["src/a.ts:8 fixed", "src/a.ts:2 fixed", "src/b.ts:2 fixed"]);
    expect(repair.changes.map((c) => c.file)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "test/shapi/quickbooks-minorversion-below-75-ignored.test.ts",
      "test/shapi/quickbooks-minorversion-below-75-ignored.2.test.ts",
      "test/shapi/quickbooks-minorversion-below-75-ignored.3.test.ts",
    ]);
    const a = repair.changes[0]!;
    expect(a.before).toBe(readFileSync(path.join(dir, "src", "a.ts"), "utf8"));
    expect(a.after.match(/minorversion=75/g)).toHaveLength(2);
    expect(a.after).not.toContain("minorversion=65");
    // every test passes against the combined change
    const final = path.join(tmp, `final${n}`);
    cpSync(dir, final, { recursive: true });
    for (const c of repair.changes) {
      mkdirSync(path.dirname(path.join(final, c.file)), { recursive: true });
      writeFileSync(path.join(final, c.file), c.after);
    }
    for (const c of repair.changes.filter((c) => c.file.startsWith("test/"))) expect(runTestFile(final, c.file).passed).toBe(true);
  }, 120_000);

  it("is partial when one call site cannot be tested, and keeps the others", async () => {
    const { dir, sites } = multiRepo({ "src/a.ts": qbo("invoices") + "\n" + qbo("internal", false) });
    const repair = await repairAdvisory({ repoDir: dir, advisory, callSites: sites, recipes: RECIPES });
    if (repair.sandbox) sandboxes.push(repair.sandbox);
    expect(repair.status).toBe("partial");
    expect(repair.sites.map((s) => [s.callSite.line, s.result.status, s.result.reason])).toEqual([
      [8, "unsupported", "the call site is not inside an exported function"],
      [2, "fixed", undefined],
    ]);
    expect(repair.changes.map((c) => c.file)).toEqual(["src/a.ts", "test/shapi/quickbooks-minorversion-below-75-ignored.2.test.ts"]);
    expect(repair.changes[0]!.after.match(/minorversion=75/g)).toHaveLength(1);
  }, 120_000);
});

/** Errors from `tsc --strict` on `files` (path → text), written to a fresh folder. */
function tsc(files: Record<string, string>): string[] {
  const dir = path.join(tmp, `tsc${++n}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const compilerOptions = { strict: true, noEmit: true, target: "es2022", module: "esnext", moduleResolution: "bundler", lib: ["es2022", "dom"], types: [] };
  writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["**/*.ts"] }));
  const run = spawnSync(process.execPath, [path.join(root, "node_modules", "typescript", "lib", "tsc.js"), "-p", dir, "--pretty", "false"], { encoding: "utf8" });
  return `${run.stdout}${run.stderr}`.split("\n").filter((l) => l.includes("error TS"));
}

/** The recipe's output for the one call site `advisory` affects in `source`. */
function fixed(source: string, advisory: Advisory): string {
  const { sites } = repo(source, advisory);
  const outcome = runRecipe(RECIPES, advisory, sites[0]!, source);
  if (outcome.status !== "applied") throw new Error(`${outcome.status}: ${outcome.reason}`);
  return outcome.change.after;
}

describe("apply-fix: the output type-checks", () => {
  const emails = byId("hubspot-marketing-emails-folderid-removed");
  const uiMode = byId("stripe-checkout-session-ui-mode-values-renamed");

  it("casts a renamed field read on a type that does not declare the new name yet", () => {
    const source = `export async function emailFolders(token: string) {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = (await res.json()) as { results: { folderId: string }[] };
  return body.results.map((e) => e.folderId);
}
`;
    expect(tsc({ "app.ts": source })).toEqual([]);
    const after = fixed(source, emails);
    expect(after).toContain("((e as any).folderIdV2 ?? e.folderId)");
    expect(tsc({ "app.ts": after })).toEqual([]);
  });

  it("leaves a type that already declares the new name uncast", () => {
    const source = `export async function emailFolders(token: string) {
  const res = await fetch("https://api.hubapi.com/marketing/v3/emails", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = (await res.json()) as { results: { folderId: string; folderIdV2?: string }[] };
  return body.results.map((e) => e.folderId);
}
`;
    const after = fixed(source, emails);
    expect(after).toContain("(e.folderIdV2 ?? e.folderId)");
    expect(tsc({ "app.ts": after })).toEqual([]);
  });

  it("widens comparisons with a nullable union that lacks the new values", () => {
    const source = `type UiMode = "hosted" | "embedded";

export async function checkoutKind(id: string, key: string) {
  const res = await fetch(\`https://api.stripe.com/v1/checkout/sessions/\${id}\`, { headers: { Authorization: \`Bearer \${key}\` } });
  const session = (await res.json()) as { ui_mode: UiMode | null };
  if (session.ui_mode === "embedded") return "in-page";
  switch (session.ui_mode) {
    case "hosted":
      return "redirect";
    default:
      return "other";
  }
}
`;
    expect(tsc({ "app.ts": source })).toEqual([]);
    const after = fixed(source, uiMode);
    expect(after).toContain('if ((["embedded","embedded_page"] as unknown[]).includes(session.ui_mode)) return "in-page";');
    expect(after).toContain('case "hosted_page" as string:\n    case "hosted":');
    expect(tsc({ "app.ts": after })).toEqual([]);
  });

  it("casts where the type comes from a package it cannot see (the Stripe SDK)", () => {
    const source = `import Stripe from "stripe";

const stripe = new Stripe("sk_test_shapi");

export async function checkoutKind(id: string) {
  const session = await stripe.checkout.sessions.retrieve(id);
  return session.ui_mode === "hosted" ? "redirect" : "in-page";
}
`;
    // Stripe's own declaration: a nullable union of the old values
    const types = `declare module "stripe" {
  export default class Stripe {
    constructor(key: string);
    checkout: { sessions: { retrieve(id: string): Promise<{ ui_mode: "hosted" | "embedded" | null }> } };
  }
}
`;
    expect(tsc({ "app.ts": source, "stripe.d.ts": types })).toEqual([]);
    const after = fixed(source, uiMode);
    expect(tsc({ "app.ts": after, "stripe.d.ts": types })).toEqual([]);
  });

  it("the HubSpot pipelines fix type-checks with the code's own parameter types", () => {
    const source = `export async function stageIds(token: string) {
  const res = await fetch("https://api.hubapi.com/crm-pipelines/v1/pipelines/deals", { headers: { Authorization: \`Bearer \${token}\` } });
  const body = await res.json();
  return body.results.map((p: { pipelineId: string; stages: { stageId: string }[] }) => [p.pipelineId, p.stages.map((s) => s.stageId)]);
}
`;
    expect(tsc({ "app.ts": fixed(source, byId("hubspot-pipelines-v1-sunset")) })).toEqual([]);
  });
});

describe("apply-fix: field reads it must not rewrite", () => {
  it("skips receivers with side effects and every kind of write", () => {
    const advisory = byId("hubspot-marketing-emails-folderid-removed");
    const source = `import axios from "axios";

export async function folder(id: string, copy: any, xs: string[]) {
  const f = (await axios.get(\`https://api.hubapi.com/marketing/v3/emails/\${id}\`)).data.folderId;
  copy.folderId++;
  --copy.folderId;
  copy.folderId += 1;
  copy.folderId ??= "x";
  delete copy.folderId;
  [copy.folderId] = xs;
  ({ folderId: copy.folderId } = { folderId: "y" });
  for (copy.folderId of xs);
  return [f, copy.folderId];
}
`;
    // Only the plain read changes: \`(await axios.get(…)).data\` evaluated twice would send the request twice.
    expect(fixed(source, advisory)).toBe(source.replace("return [f, copy.folderId];", "return [f, (copy.folderIdV2 ?? copy.folderId)];"));
  });

  it("rewrites a renamed field inside a renamed-value comparison once, not as two overlapping edits", () => {
    const base = byId("stripe-checkout-session-ui-mode-values-renamed");
    const advisory: Advisory = { ...base, id: "test-field-and-enum", fix: { fields: [{ from: "ui_mode", to: "mode" }], enums: [{ field: "ui_mode", values: [{ from: "hosted", to: "hosted_page" }] }] } };
    const source = `export async function checkoutKind(id: string, key: string) {
  const res = await fetch(\`https://api.stripe.com/v1/checkout/sessions/\${id}\`, { headers: { Authorization: \`Bearer \${key}\` } });
  const session = await res.json();
  return session.ui_mode === "hosted" ? "redirect" : "in-page";
}
`;
    expect(fixed(source, advisory)).toContain('return ["hosted","hosted_page"].includes((session.mode ?? session.ui_mode)) ? "redirect" : "in-page";');
  });
});

describe("apply-fix: query values", () => {
  it("does not lower a value that is already at or above the advisory's threshold", () => {
    const advisory = byId("quickbooks-minorversion-below-75-ignored");
    const source = `import axios from "axios";

const reports = axios.create({ baseURL: "https://quickbooks.api.intuit.com/v3/company/1/reports?minorversion=80" });

export async function invoices(realmId: string, token: string) {
  const res = await fetch(\`https://quickbooks.api.intuit.com/v3/company/\${realmId}/query?query=x&minorversion=65\`, { headers: { Authorization: \`Bearer \${token}\` } });
  return [await res.json(), reports];
}
`;
    const after = fixed(source, advisory);
    expect(after).toContain("&minorversion=75`");
    expect(after).toContain("reports?minorversion=80");
  });
});
