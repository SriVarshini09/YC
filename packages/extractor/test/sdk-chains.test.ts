import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type CallSite } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// SDK call shapes the method tables could not reach: GraphQL clients, Bolt's WebClient, Twilio's resource-by-sid chains.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-29T12:00:00Z");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function scan(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-sdk-"));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return extractCallSites(dir);
}
const sitesOf = (files: Record<string, string>) => scan(files).callSites;
const affectedIds = (files: Record<string, string>) =>
  matchAdvisories(createApiLock(scan(files), "test"), advisories, { now }).affected.map((f) => `${f.callSite.line} ${f.advisory.id}`);
const line = (s: CallSite) => `${s.line} ${s.operation} ${s.method ?? "?"} ${s.provider} ${s.endpoint}`;

describe("GraphQL through an SDK", () => {
  it("maps shopify-api-node's graphql() to the Admin GraphQL endpoint, and Octokit's to /graphql", () => {
    const files = {
      "a.ts": `import Shopify from "shopify-api-node";
import { Octokit } from "@octokit/rest";
const shopify = new Shopify({ shopName: "s", accessToken: "t", apiVersion: "2026-07" });
const octokit = new Octokit();
export const shop = () => shopify.graphql("{ shop { name } }");
export const viewer = () => octokit.graphql("{ viewer { login } }");
`,
    };
    expect(sitesOf(files).map(line)).toEqual([
      "5 graphql POST shopify /admin/api/{version}/graphql.json",
      "6 graphql POST github /graphql",
    ]);
    expect(affectedIds(files)).toContain("5 shopify-non-expiring-offline-tokens-rejected");
  });

  it("maps @shopify/admin-api-client's request(query) to the Admin GraphQL endpoint, not an Octokit route", () => {
    const files = {
      "a.ts": `import { createAdminApiClient } from "@shopify/admin-api-client";
import { Octokit } from "@octokit/rest";
const client = createAdminApiClient({ storeDomain: "s.myshopify.com", apiVersion: "2026-07", accessToken: "t" });
const octokit = new Octokit();
const QUERY = \`query { shop { name } }\`;
export const shop = () => client.request(QUERY, { variables: {}, headers: { "x-request-id": "1" } });
export const tagged = (gql: any) => client.request(gql\`query { shop { id } }\`);
export const pulls = () => octokit.request("/repos/o/r/pulls");
export const route = () => client.request("GET /admin/api/2026-07/shop.json");
`,
    };
    const sites = sitesOf(files);
    expect(sites.map(line)).toEqual([
      "6 request POST shopify /admin/api/{version}/graphql.json",
      "7 request POST shopify /admin/api/{version}/graphql.json",
      "8 request GET github /repos/o/r/pulls",
      "9 request GET shopify /admin/api/2026-07/shop.json",
    ]);
    expect(sites[0]!.surface.headers).toContainEqual({ name: "x-request-id", value: "1" });
    expect(affectedIds(files)).toContain("6 shopify-non-expiring-offline-tokens-rejected");
  });
});

describe("Slack Bolt", () => {
  it("maps app.client.<method> and the client a listener receives to the Web API method table", () => {
    const files = {
      "a.ts": `import { App } from "@slack/bolt";
const app = new App({ token: "xoxb", signingSecret: "s" });
export const share = (channel: string, file: Buffer) => app.client.files.upload({ channels: channel, file });
export const say = (channel: string) => app.client.chat.postMessage({ channel, text: "hi" });
app.command("/share", async ({ ack, client }) => {
  await ack();
  await client.files.upload({ channels: "C1", content: "x" });
});
app.event("app_mention", async ({ event, client: web }) => {
  await web.chat.postMessage({ channel: event.channel, text: "hi" });
});
`,
    };
    const sites = sitesOf(files).filter((s) => s.resolved);
    expect(sites.map(line)).toEqual([
      "3 client.files.upload POST slack /api/files.upload",
      "4 client.chat.postMessage POST slack /api/chat.postMessage",
      "7 files.upload POST slack /api/files.upload",
      "10 chat.postMessage POST slack /api/chat.postMessage",
    ]);
    expect(affectedIds(files)).toEqual(["3 slack-files-upload-retired", "7 slack-files-upload-retired"]);
  });
});

describe("Twilio resources picked by sid", () => {
  it("maps client.messages(sid).fetch() and .update(), and matches the SDK's errorCode", () => {
    const files = {
      "a.ts": `import twilio from "twilio";
const client = twilio("AC1", "token");
export async function failover(sid: string) {
  const msg = await client.messages(sid).fetch();
  return msg.errorCode === 30036;
}
export const cancel = (sid: string) => client.messages(sid).update({ status: "canceled" });
export const call = (sid: string) => client.calls(sid).fetch();
export const hangUp = (sid: string) => client.calls(sid).update({ status: "completed" });
export const endConference = (sid: string) => client.conferences(sid).update({ status: "completed" });
export const created = () => client.messages.create({ to: "+1", from: "+2", body: "hi" }).then((m) => m.sid);
`,
    };
    expect(sitesOf(files).map(line)).toEqual([
      "4 messages().fetch GET twilio /2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json",
      "7 messages().update POST twilio /2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json",
      "8 calls().fetch GET twilio /2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json",
      "9 calls().update POST twilio /2010-04-01/Accounts/{AccountSid}/Calls/{Sid}.json",
      "10 conferences().update POST twilio /2010-04-01/Accounts/{AccountSid}/Conferences/{Sid}.json",
      "11 messages.create POST twilio /2010-04-01/Accounts/{AccountSid}/Messages.json",
    ]);
    expect(affectedIds(files)).toEqual(["4 twilio-rcs-undelivered-error-code-30046"]);
  });
});

describe("URLs no recognized client sends", () => {
  it("records them as resolved with an unknown method, as the api.lock schema documents", () => {
    const sites = sitesOf({ "a.ts": `const UPLOAD = "https://slack.com/api/files.upload";\nexport const f = (ctx: any) => ctx.fetch(UPLOAD);\n` });
    expect(sites).toMatchObject([{ client: "url", provider: "slack", method: null, endpoint: "/api/files.upload", resolved: true }]);
  });
});
