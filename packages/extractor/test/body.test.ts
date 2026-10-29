import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiLock, matchAdvisories, type Advisory, type CallSite } from "@shapi/core";
import { extractCallSites, loadPythonParser } from "@shapi/extractor";

const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-body-"));
const files: Record<string, string> = {
  "package.json": JSON.stringify({ dependencies: { openai: "^5.0.0", "@anthropic-ai/sdk": "^1.0.0", stripe: "^17.0.0", axios: "^1.7.0", got: "^14.0.0" } }),
  "src/ai.ts": `import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
const openai = new OpenAI();
const anthropic = new Anthropic();
const MODEL = "gpt-4o-2024-05-13";

export async function summarize(text: string, model: string) {
  const a = await openai.chat.completions.create({ model: MODEL, messages: [{ role: "user", content: text }] });
  const b = await openai.chat.completions.create({ model, messages: [] });
  const c = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 100, messages: [] });
  return [a, b, c];
}
`,
  "src/http.ts": `import axios from "axios";
import got from "got";
const body = { model: "o1-preview", input: "hi" };

export async function direct(key: string) {
  await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: key }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }) });
  await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4.1" });
  await got.post("https://api.openai.com/v1/chat/completions", { json: body });
  await fetch("https://api.openai.com/v1/models");
}
`,
  "src/billing.ts": `import Stripe from "stripe";
const stripe = new Stripe("sk_test_x", { apiVersion: "2026-09-30.endive" });

export async function pay() {
  await stripe.checkout.sessions.create({ mode: "payment", payment_method_types: ["card"], line_items: [] });
  await stripe.checkout.sessions.create({ mode: "payment", line_items: [] });
}
`,
  "app/ai.py": `import requests
from openai import OpenAI
from anthropic import Anthropic

client = OpenAI()
claude = Anthropic()

def run(text, model):
    client.chat.completions.create(model="gpt-4o-2024-05-13", messages=[])
    client.chat.completions.create(model=model, messages=[])
    claude.messages.create(model="claude-sonnet-4-5", max_tokens=100, messages=[])
    requests.post("https://api.openai.com/v1/chat/completions", json={"model": "o1-mini", "messages": []})
`,
};

let sites: CallSite[] = [];
beforeAll(async () => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  await loadPythonParser();
  sites = extractCallSites(dir).callSites;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bodyAt = (file: string, line: number) => {
  const s = sites.find((c) => c.file === file && c.line === line);
  if (!s) throw new Error(`no call site at ${file}:${line}: ${sites.map((c) => `${c.file}:${c.line}`).join(", ")}`);
  return s.surface.body;
};

describe("request body fields", () => {
  it("reads SDK method parameters, following a same-file const, with unknown values as null", () => {
    expect(bodyAt("src/ai.ts", 8)).toEqual([
      { name: "model", value: "gpt-4o-2024-05-13" },
      { name: "messages", value: null },
    ]);
    expect(bodyAt("src/ai.ts", 9)).toEqual([
      { name: "model", value: null },
      { name: "messages", value: null },
    ]);
    expect(bodyAt("src/ai.ts", 10)?.find((b) => b.name === "model")).toEqual({ name: "model", value: "claude-sonnet-4-5" });
  });

  it("reads fetch JSON.stringify bodies, axios data and got json; a call without a body has none", () => {
    expect(bodyAt("src/http.ts", 6)).toEqual([
      { name: "model", value: "gpt-4o-mini" },
      { name: "messages", value: null },
    ]);
    expect(bodyAt("src/http.ts", 7)).toEqual([{ name: "model", value: "gpt-4.1" }]);
    expect(bodyAt("src/http.ts", 8)).toEqual([
      { name: "model", value: "o1-preview" },
      { name: "input", value: "hi" },
    ]);
    expect(bodyAt("src/http.ts", 9)).toBeUndefined();
  });

  it("reads Python SDK keyword arguments and requests json=", () => {
    expect(bodyAt("app/ai.py", 9)?.[0]).toEqual({ name: "model", value: "gpt-4o-2024-05-13" });
    expect(bodyAt("app/ai.py", 10)?.[0]).toEqual({ name: "model", value: null });
    expect(bodyAt("app/ai.py", 11)?.[0]).toEqual({ name: "model", value: "claude-sonnet-4-5" });
    expect(bodyAt("app/ai.py", 12)?.[0]).toEqual({ name: "model", value: "o1-mini" });
  });
});

describe("body triggers", () => {
  const advisory = (id: string, over: Partial<Advisory>): Advisory => ({
    id,
    provider: "openai",
    title: id,
    summary: "test",
    endpoint: { method: "POST", path: "/v1/chat/completions" },
    changeClass: "version-sunset",
    trigger: { any: true },
    firstObserved: null,
    publishedNotice: null,
    effectiveDate: "2026-12-01",
    severity: "high",
    migrationNote: "Move to a current model.",
    sources: ["https://example.com/deprecations"],
    status: "verified",
    ...over,
  });
  const models = advisory("models-retired", { trigger: { body: [{ field: "model", values: ["gpt-4o-2024-05-13", "o1-mini", "gpt-4.1"] }] } });
  const pmt = advisory("pmt-removed", {
    provider: "stripe",
    endpoint: { method: "POST", path: "/v1/checkout/sessions" },
    trigger: { body: [{ field: "payment_method_types" }] },
  });

  it("is affected only where the body sets a listed value; a dynamic value or another model is exposed", () => {
    const result = matchAdvisories(createApiLock({ callSites: sites, declared: [] }, "test"), [models], { now: new Date("2026-10-29") });
    expect(result.affected.map((f) => `${f.callSite.file}:${f.callSite.line} ${f.reasons.join("; ")}`)).toEqual([
      'app/ai.py:9 sends model: "gpt-4o-2024-05-13" in the request body',
      'app/ai.py:12 sends model: "o1-mini" in the request body',
      'src/ai.ts:8 sends model: "gpt-4o-2024-05-13" in the request body',
      'src/http.ts:7 sends model: "gpt-4.1" in the request body',
    ]);
    expect(result.exposed.map((f) => `${f.callSite.file}:${f.callSite.line}`)).toEqual(["app/ai.py:10", "src/ai.ts:9", "src/http.ts:6", "src/http.ts:8"]);
  });

  it("is affected where the body sends the field at all, when no values are given", () => {
    const result = matchAdvisories(createApiLock({ callSites: sites, declared: [] }, "test"), [pmt], { now: new Date("2026-10-29") });
    expect(result.affected.map((f) => `${f.callSite.file}:${f.callSite.line} ${f.reasons.join("; ")}`)).toEqual(["src/billing.ts:5 sends payment_method_types in the request body"]);
    expect(result.exposed.map((f) => `${f.callSite.file}:${f.callSite.line}`)).toEqual(["src/billing.ts:6"]);
  });
});
