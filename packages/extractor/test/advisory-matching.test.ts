import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories, type CallSite, type MatchResult } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// Idiomatic code for advisories that used to match nothing: each call is marked with the advisories it must be
// affected by, possibly affected by, or exposed to. A line without "affected:" or "possible:" must be in neither.
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));
const now = new Date("2026-10-29T12:00:00Z");

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    dependencies: {
      "@google/genai": "^1.0.0",
      "@slack/web-api": "^7.0.0",
      "intuit-oauth": "^4.0.0",
      jsforce: "^3.0.0",
      "node-quickbooks": "^2.0.0",
      openai: "^5.0.0",
      "shopify-api-node": "^3.0.0",
      stripe: "^17.0.0",
      twilio: "^5.0.0",
      "twitter-api-v2": "^1.0.0",
      "xero-node": "^9.0.0",
    },
  }),
  "src/slack.ts": `import { WebClient } from "@slack/web-api";
const web = new WebClient("xoxb");
export async function share(channel: string, file: Buffer) {
  await web.files.upload({ channels: channel, file }); // affected: slack-files-upload-retired
  await web.files.uploadV2({ channel_id: channel, file });
  await web.chat.postMessage({ channel, text: "hi" });
}
`,
  // URLs sent by a project helper: the method is unknown (a loose site is reported where the URL is written)
  "src/slack-helper.ts": `const UPLOAD = "https://slack.com/api/files.upload"; // possible: slack-files-upload-retired
const POST = "https://slack.com/api/chat.postMessage";
export const upload = (ctx: any) => ctx.fetch(UPLOAD, {});
export const post = (ctx: any) => ctx.fetch(POST, {});
`,
  "src/openai.ts": `import OpenAI from "openai";
const openai = new OpenAI();
export async function run(file: any) {
  await openai.audio.translations.create({ file, model: "whisper-1" }); // affected: openai-audio-translations-endpoint-shutdown
  await openai.audio.transcriptions.create({ file, model: "gpt-transcribe" });
  await openai.evals.list(); // affected: openai-evals-api-shutdown
  await openai.evals.runs.create("eval_1", {}); // affected: openai-evals-api-shutdown
  await openai.beta.assistants.list(); // affected: openai-assistants-api-shutdown
  const thread = await openai.beta.threads.create(); // affected: openai-assistants-threads-api-shutdown
  await openai.beta.threads.messages.create(thread.id, { role: "user", content: "hi" }); // affected: openai-assistants-threads-api-shutdown
  await openai.responses.create({ model: "gpt-4o-2024-08-06", input: "hi" }); // affected: openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14-responses
  await openai.responses.create({ model: "o3-mini", input: "hi" }); // affected: openai-legacy-gpt-o-series-shutdown-2026-10-23-responses
  await openai.responses.create({ model: "gpt-6-luna", input: "hi" }); // exposed: openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14-responses
  await openai.chat.completions.create({ model: "gpt-6-luna", messages: [] }); // exposed: openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14
}
`,
  "src/gemini.ts": `import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: "k" });
export async function run(model: string) {
  await ai.models.generateContent({ model: "gemini-2.0-flash", contents: "hi" }); // affected: google-gemini-2-0-flash-shutdown-sdk
  await ai.models.generateContent({ model: "gemini-2.5-flash-preview-tts", contents: "hi" }); // affected: google-gemini-2-5-preview-tts-shutdown-sdk
  await ai.models.generateContent({ model: "models/gemini-2.5-flash-image", contents: "hi" }); // affected: google-gemini-2-5-flash-image-shutdown-sdk
  await ai.models.generateContent({ model: "gemini-3.6-flash", contents: "hi" }); // exposed: google-gemini-2-0-flash-shutdown-sdk
  await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent", { method: "POST" }); // affected: google-gemini-2-0-flash-shutdown
  await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent", { method: "POST" });
  await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/\${model}:generateContent\`, { method: "POST" }); // possible: google-gemini-2-0-flash-shutdown-sdk google-gemini-2-5-flash-image-shutdown-sdk google-gemini-2-5-preview-tts-shutdown-sdk
  await ai.models.generateContent({ model, contents: "hi" }); // possible: google-gemini-2-0-flash-shutdown-sdk google-gemini-2-5-flash-image-shutdown-sdk google-gemini-2-5-preview-tts-shutdown-sdk
}
`,
  "src/xero.ts": `import { XeroClient } from "xero-node";
const xero = new XeroClient({ clientId: "a", clientSecret: "b" });
export async function sync(t: string) {
  await xero.accountingApi.emailInvoice(t, "inv", {}); // affected: xero-accounting-transactions-scope-split exposed: xero-invoices-email-daily-limit-429
  await xero.accountingApi.createCreditNoteAllocation(t, "cn", {}); // affected: xero-accounting-transactions-scope-split xero-allocations-contact-mismatch-rejected
  await xero.payrollAUApi.createPayItem(t, {}); // affected: xero-au-payroll-isqualifyingearnings-required
  await fetch("https://api.xero.com/payroll.xro/2.0/earningsRates", { method: "POST", headers: { "xero-tenant-id": t } }); // affected: xero-au-payroll-isqualifyingearnings-required-earningsrates
  await xero.payrollNZApi.updateEmployeeTax(t, "e", {}); // affected: xero-nz-payroll-employee-tax-kiwisaverstatus-required
  await xero.financeApi.getAccountingActivityAccountUsage(t); // affected: xero-finance-accounting-activities-decommissioned
  await xero.accountingApi.getOrganisations(t); // affected: xero-accounting-transactions-scope-split exposed: xero-organisation-class-ultra-enum
}
export async function premium(t: string) {
  const res = await fetch("https://api.xero.com/api.xro/2.0/Organisation", { headers: { "xero-tenant-id": t } }); // affected: xero-accounting-transactions-scope-split xero-organisation-class-ultra-enum
  const body = await res.json();
  return body.Organisations[0].Class === "PREMIUM";
}
export async function name(t: string) {
  const res = await fetch("https://api.xero.com/api.xro/2.0/Organisation", { headers: { "xero-tenant-id": t } }); // affected: xero-accounting-transactions-scope-split exposed: xero-organisation-class-ultra-enum
  const body = await res.json();
  return body.Organisations[0].Name;
}
`,
  "src/quickbooks.ts": `import OAuthClient from "intuit-oauth";
const QuickBooks = require("node-quickbooks");
const oauth = new OAuthClient({ clientId: "a", clientSecret: "b", environment: "sandbox", redirectUri: "https://x" });
export const refresh = () => oauth.refresh(); // affected: quickbooks-refresh-token-five-year-hard-expiry
const qbo = new QuickBooks("k", "s", "t", false, "realm", true, false, 75, "2.0", "r");
export const info = (cb: any) => qbo.getCompanyInfo("realm", cb); // exposed: quickbooks-companyinfo-neoenabled-removed quickbooks-minorversion-below-75-ignored
export const renew = (cb: any) => qbo.refreshAccessToken(cb); // affected: quickbooks-refresh-token-five-year-hard-expiry
export async function neo(realm: string) {
  const res = await fetch(\`https://quickbooks.api.intuit.com/v3/company/\${realm}/companyinfo/\${realm}\`); // affected: quickbooks-companyinfo-neoenabled-removed exposed: quickbooks-minorversion-below-75-ignored
  const body = await res.json();
  return body.CompanyInfo.NameValue.find((nv: any) => nv.Name === "NeoEnabled");
}
export async function industry(realm: string) {
  const res = await fetch(\`https://quickbooks.api.intuit.com/v3/company/\${realm}/companyinfo/\${realm}\`); // exposed: quickbooks-companyinfo-neoenabled-removed
  const body = await res.json();
  return body.CompanyInfo.NameValue.find((nv: any) => nv.Name === "IndustryType");
}
`,
  "src/twilio.ts": `import twilio from "twilio";
const client = twilio("AC1", "token");
export const conferences = () => client.conferences.list({ limit: 20 }); // affected: twilio-conference-list-default-in-progress
export async function failover(account: string, sid: string) {
  const res = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${account}/Messages/\${sid}.json\`); // affected: twilio-rcs-undelivered-error-code-30046
  const msg = await res.json();
  return msg.error_code === 30036;
}
export async function optedOut(account: string, sid: string) {
  const res = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${account}/Messages/\${sid}.json\`); // exposed: twilio-rcs-undelivered-error-code-30046
  const msg = await res.json();
  return msg.error_code === 21610;
}
export async function sdkFailover(sid: string) {
  const msg = await client.messages(sid).fetch(); // affected: twilio-rcs-undelivered-error-code-30046
  return msg.errorCode === 30036;
}
`,
  "src/x.ts": `import { TwitterApi } from "twitter-api-v2";
const client = new TwitterApi("token");
export const follow = (me: string, them: string) => client.v2.follow(me, them); // affected: x-self-serve-follow-writes-removed
export const like = (me: string, tweet: string) => client.readWrite.v2.like(me, tweet); // affected: x-self-serve-like-writes-removed
export const unlike = (me: string, tweet: string) => client.v2.unlike(me, tweet);
export async function subscribe(token: string) {
  await fetch("https://api.x.com/2/activity/subscriptions", { method: "POST", headers: { authorization: token }, body: JSON.stringify({ event_type: "ProfileBioUpdate" }) }); // affected: x-activity-api-pascalcase-event-types-removed
}
export async function bioSubscriptions(token: string) {
  const res = await fetch("https://api.x.com/2/activity/subscriptions", { headers: { authorization: token } }); // affected: x-activity-api-pascalcase-event-types-removed
  const body = await res.json();
  return body.data.filter((s: any) => s.event_type === "ProfileBioUpdate");
}
`,
  "src/salesforce.ts": `import jsforce from "jsforce";
const conn = new jsforce.Connection({ loginUrl: "https://login.salesforce.com" });
export const login = (u: string, p: string) => conn.login(u, p); // possible: salesforce-soap-login-broad-ip-range-token-required salesforce-soap-login-disabled-when-unused salesforce-soap-login-use-any-api-auth-required
export const accounts = () => conn.query("SELECT Id FROM Account");
`,
  "src/shopify.ts": `import Shopify from "shopify-api-node";
const shopify = new Shopify({ shopName: "s", accessToken: "t", apiVersion: "2026-01" });
export const addTag = () => shopify.scriptTag.create({ event: "onload", src: "https://x/y.js" }); // affected: shopify-script-tags-stop-running possible: shopify-admin-api-2026-01-unsupported shopify-admin-api-2026-04-unsupported
export const products = () => shopify.product.list();
export const shop = () => shopify.graphql("{ shop { name } }"); // affected: shopify-non-expiring-offline-tokens-rejected possible: shopify-admin-api-2026-01-unsupported shopify-admin-api-2026-04-unsupported
`,
  "src/stripe.ts": `import Stripe from "stripe";
const stripe = new Stripe("sk_test_x");
export const embedded = () => stripe.checkout.sessions.create({ ui_mode: "embedded", mode: "payment" }); // affected: stripe-checkout-session-ui-mode-values-renamed
export const hosted = () => stripe.checkout.sessions.create({ ui_mode: "hosted_page", mode: "payment" }); // exposed: stripe-checkout-session-ui-mode-values-renamed
`,
  "src/meta.ts": `export async function fans(pageId: string, token: string) {
  const res = await fetch(\`https://graph.facebook.com/\${pageId}/insights?metric=page_fans&access_token=\${token}\`); // affected: meta-graph-page-insights-impressions-fans-removed exposed: meta-graph-page-insights-reach-video-views-removed
  return res.json();
}
export async function estimate(adset: string) {
  const res = await fetch(\`https://graph.facebook.com/v26.0/\${adset}/delivery_estimate\`); // affected: meta-graph-delivery-estimate-fields-removed
  const body = await res.json();
  return body.data[0].estimate_dau;
}
export async function oembed(url: string) {
  const res = await fetch(\`https://graph.facebook.com/instagram_oembed?url=\${url}\`); // affected: meta-graph-instagram-oembed-fields-removed
  const body = await res.json();
  return body.thumbnail_url;
}
`,
};

let dir = "";
let sites: CallSite[] = [];
let match: MatchResult;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "shapi-advmatch-"));
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const extracted = extractCallSites(dir);
  sites = extracted.callSites;
  match = matchAdvisories(createApiLock(extracted, "test"), advisories, { now });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Bucket = "affected" | "possible" | "exposed";

/** The markers on each source line: `// affected: a b possible: c exposed: d`. */
function markers(): Map<string, Record<Bucket, string[]>> {
  const out = new Map<string, Record<Bucket, string[]>>();
  for (const [file, text] of Object.entries(FILES)) {
    if (!file.endsWith(".ts")) continue;
    text.split("\n").forEach((line, i) => {
      const marks: Record<Bucket, string[]> = { affected: [], possible: [], exposed: [] };
      const comment = line.includes("// ") ? line.slice(line.lastIndexOf("// ") + 3) : "";
      for (const m of comment.matchAll(/(affected|possible|exposed): ([a-z0-9 -]+?)(?=\s+(?:affected|possible|exposed):|$)/g)) {
        marks[m[1] as Bucket] = m[2]!.trim().split(/\s+/);
      }
      out.set(`${file}:${i + 1}`, marks);
    });
  }
  return out;
}

const at = (bucket: Bucket, where: string) =>
  match[bucket].filter((f) => `${f.callSite.file}:${f.callSite.line}` === where).map((f) => f.advisory.id).sort();

describe("advisories against the code they describe", () => {
  it("finds a call site on every marked line", () => {
    const lines = new Set(sites.map((s) => `${s.file}:${s.line}`));
    for (const [where, marks] of markers()) {
      if (marks.affected.length || marks.possible.length || marks.exposed.length) expect(lines.has(where), where).toBe(true);
    }
  });

  it("puts each call in exactly the marked affected and possible buckets, and nothing else there", () => {
    for (const [where, marks] of markers()) {
      expect(at("affected", where), `${where} affected`).toEqual([...marks.affected].sort());
      expect(at("possible", where), `${where} possible`).toEqual([...marks.possible].sort());
    }
  });

  it("reports the marked exposures", () => {
    for (const [where, marks] of markers()) {
      for (const id of marks.exposed) expect(at("exposed", where), `${where} exposed`).toContain(id);
    }
  });

  it("keeps a Gemini call that names the model in its path out of the advisories for a model passed as a parameter", () => {
    // gemini-2.0-flash in the path is affected once, by the path advisory; gemini-2.5-pro is exposed to no shutdown
    expect(at("exposed", "src/gemini.ts:8")).toEqual([]);
    expect(at("exposed", "src/gemini.ts:9")).toEqual([]);
  });

  it("explains a possibly affected loose URL by its unknown method", () => {
    const loose = match.possible.find((f) => f.advisory.id === "slack-files-upload-retired");
    expect(loose?.reasons).toEqual(["calls ? /api/files.upload, but SHAPI cannot tell the method (affected if it is POST)"]);
  });

  it("records numeric comparisons as enum values, and the enum value filter picks the old code", () => {
    const failover = sites.find((s) => s.file === "src/twilio.ts" && s.line === 5);
    expect(failover?.surface.enums).toEqual([{ field: "error_code", values: ["30036"] }]);
    const affected = match.affected.find((f) => f.advisory.id === "twilio-rcs-undelivered-error-code-30046");
    expect(affected?.reasons).toEqual(["compares error_code to \"30036\""]);
  });
});
