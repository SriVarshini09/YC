import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type Advisory, type LockedCallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { loadRecording, replay } from "@shapi/canary";
import { ShapeStore } from "@shapi/shapes";
import { RECIPES, repairCallSite } from "@shapi/repair";

// Contract tests for call sites that use axios, got or an SDK instead of fetch. None of these
// packages is installed in the test repos: the generated test replaces the client with a fake.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisories = loadAdvisories(path.join(root, "advisories"));
const byId = (id: string) => advisories.find((a) => a.id === id)!;
const now = new Date("2026-10-23");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-clients-"));
const sandboxes: string[] = [];
afterAll(() => {
  for (const d of [tmp, ...sandboxes]) rmSync(d, { recursive: true, force: true });
});

let n = 0;
function repo(source: string, advisory: Advisory, deps: Record<string, string>): { dir: string; site: LockedCallSite } {
  const dir = path.join(tmp, `r${++n}`);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `r${n}`, private: true, type: "module", dependencies: deps }));
  writeFileSync(path.join(dir, "src", "app.ts"), source);
  const [site] = matchAdvisories(createApiLock(extractCallSites(dir), "test"), [advisory], { now }).affected.map((f) => f.callSite);
  if (!site) throw new Error("no affected call site");
  return { dir, site };
}

async function repair(dir: string, advisory: Advisory, site: LockedCallSite, shapes = {}) {
  const result = await repairCallSite({ repoDir: dir, advisory, callSite: site, recipes: RECIPES, ...shapes });
  if (result.sandbox) sandboxes.push(result.sandbox);
  return result;
}

describe("contract tests beyond fetch", () => {
  it("axios: fixes the demo's HubSpot pipelines call on an axios instance with a baseURL", async () => {
    const advisory = byId("hubspot-pipelines-v1-sunset");
    const demo = path.join(tmp, "demo");
    cpSync(path.join(root, "fixtures", "demo-ts"), demo, { recursive: true });
    const [site] = matchAdvisories(createApiLock(extractCallSites(demo), "test"), [advisory], { now }).affected.map((f) => f.callSite);
    expect(site).toMatchObject({ file: "src/crm.ts", client: "axios" });
    const result = await repair(demo, advisory, site!);
    expect(result.status).toBe("fixed");
    expect(result.baseline?.passed).toBe(false);
    expect(result.changes[0]!.after).toContain('hubspot.get("/crm/pipelines/2026-09/deals"');
    expect(result.test!.content).toContain('vi.mock("axios"');
  }, 60_000);

  it("got: moves a QuickBooks minorversion sent as searchParams", async () => {
    const advisory = byId("quickbooks-minorversion-below-75-ignored");
    const { dir, site } = repo(
      `import got from "got";

export async function invoices(realmId: string, token: string) {
  const body: any = await got(\`https://quickbooks.api.intuit.com/v3/company/\${realmId}/query\`, {
    searchParams: { query: "select * from Invoice", minorversion: 65 },
    headers: { Authorization: \`Bearer \${token}\` },
  }).json();
  return body.QueryResponse.Invoice;
}
`,
      advisory,
      { got: "^14.0.0" },
    );
    expect(site.client).toBe("got");
    const result = await repair(dir, advisory, site);
    expect(result.status).toBe("fixed");
    expect(result.baseline?.passed).toBe(false);
    expect(result.changes[0]!.after).toContain("minorversion: 75 }");
    expect(result.test!.content).toContain('vi.mock("got"');
  }, 60_000);

  it("Stripe SDK: accepts the renamed ui_mode values, verified through a fake Stripe client", async () => {
    const advisory = byId("stripe-checkout-session-ui-mode-values-renamed");
    const { dir, site } = repo(
      `import Stripe from "stripe";

const stripe = new Stripe("sk_test_shapi");

export async function checkoutKind(id: string) {
  const session = await stripe.checkout.sessions.retrieve(id);
  return session.ui_mode === "hosted" ? "redirect" : "in-page";
}
`,
      advisory,
      { stripe: "^17.0.0" },
    );
    expect(site).toMatchObject({ kind: "sdk", client: "stripe", endpoint: "/v1/checkout/sessions/{session}" });
    const result = await repair(dir, advisory, site);
    expect(result.status).toBe("fixed");
    expect(result.baseline?.passed).toBe(false);
    // Stripe's own type for ui_mode is a nullable union without the new values: the list is widened for tsc.
    expect(result.changes[0]!.after).toContain('(["hosted","hosted_page"] as unknown[]).includes(session.ui_mode)');
    expect(result.test!.content).toContain('vi.mock("stripe"');
  }, 60_000);

  it("Octokit: accepts 200 as well as 204 from workflow_dispatch, from the recorded responses", async () => {
    const advisory = byId("github-workflow-dispatch-204-to-200");
    const store = ShapeStore.open(":memory:");
    const replayed = replay(loadRecording(path.join(root, "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json")), store, "test");
    store.close();
    const { dir, site } = repo(
      `import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function deploy(owner: string, repo: string) {
  const res = await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: "deploy.yml", ref: "main" });
  if (res.status !== 204) throw new Error(\`dispatch failed with \${res.status}\`);
  return true;
}
`,
      advisory,
      { "@octokit/rest": "^21.0.0" },
    );
    expect(site).toMatchObject({ kind: "sdk", client: "@octokit/rest" });
    const result = await repair(dir, advisory, site, { before: replayed.before!.shape, after: replayed.after.shape });
    expect(result.status).toBe("fixed");
    expect(result.baseline?.output).toContain("dispatch failed with 200");
    expect(result.changes[0]!.after).toContain("![200, 204].includes(res.status)");
    expect(result.test!.content).toContain('vi.mock("@octokit/rest"');
  }, 60_000);

  it("refuses a request fix on an SDK call, which builds its own requests", async () => {
    const advisory: Advisory = { ...byId("meta-graph-v21-sunset"), id: "test-sdk-path", provider: "stripe", endpoint: { method: "*", path: "/v1/**" } };
    const { dir, site } = repo(
      `import Stripe from "stripe";
const stripe = new Stripe("sk_test_shapi");
export async function kind(id: string) {
  return (await stripe.checkout.sessions.retrieve(id)).ui_mode;
}
`,
      advisory,
      { stripe: "^17.0.0" },
    );
    const result = await repair(dir, advisory, site);
    expect(result).toMatchObject({ status: "unsupported", reason: "the fix changes the request, which stripe builds itself" });
  });
});
