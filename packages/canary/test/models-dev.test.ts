import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AdvisorySchema, createApiLock, matchAdvisories, type CallSite } from "@shapi/core";
import { modelsDevDrafts, modelsDevHost, run, type ModelsDevApi } from "@shapi/canary";

// Execution plan C-04: models.dev deprecations become version-sunset drafts.
const api: ModelsDevApi = {
  openai: { name: "OpenAI", npm: "@ai-sdk/openai", doc: "https://platform.openai.com/docs/models", models: { "o3-mini": { id: "o3-mini", name: "o3-mini", status: "deprecated" }, "gpt-5": { id: "gpt-5" } } },
  anthropic: { name: "Anthropic", npm: "@ai-sdk/anthropic", models: { "claude-3-opus": { id: "claude-3-opus", status: "deprecated" } } },
  google: { name: "Google", npm: "@ai-sdk/google", models: { "gemini-2.5-flash-image": { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", status: "deprecated" } } },
  // An OpenAI-compatible host SHAPI doesn't know: skipped.
  deepseek: { name: "DeepSeek", api: "https://api.deepseek.com", models: { old: { status: "deprecated" } } },
  // A known host through `api`.
  "openai-proxy": { name: "Proxy", api: "https://api.openai.com/v1", models: { "gpt-4": { status: "deprecated" } } },
  broken: { api: "not a url", models: { x: { status: "deprecated" } } },
};

describe("models.dev ingest (C-04)", () => {
  it("drafts every deprecated model on a host in providers.json, and nothing else", () => {
    expect(modelsDevHost(api.openai!)).toBe("api.openai.com");
    expect(modelsDevHost(api.deepseek!)).toBe("api.deepseek.com");
    expect(modelsDevHost(api.broken!)).toBeUndefined();
    const drafts = modelsDevDrafts(api, { today: "2026-10-30" });
    expect(drafts.map((d) => `${d.provider} ${d.model}`)).toEqual(["anthropic claude-3-opus", "google-gemini gemini-2.5-flash-image", "openai gpt-4", "openai o3-mini"]);
    for (const { advisory } of drafts) {
      expect(AdvisorySchema.parse(advisory)).toEqual(advisory);
      expect(advisory).toMatchObject({ changeClass: "version-sunset", status: "unverified", firstObserved: "2026-10-30", effectiveDate: "2026-10-30" });
    }
    const gemini = drafts.find((d) => d.provider === "google-gemini")!.advisory;
    expect(gemini.trigger).toEqual({ body: [{ field: "model", values: ["gemini-2.5-flash-image", "models/gemini-2.5-flash-image"] }] });
    expect(gemini.endpoint).toEqual({ method: "POST", path: "/*/models/{?}:*" });
    expect(drafts.find((d) => d.model === "o3-mini")!.advisory).toMatchObject({ id: "openai-o3-mini-deprecated", endpoint: { method: "POST", path: "/v1/**" }, sources: ["https://models.dev/api.json", "https://platform.openai.com/docs/models"] });
  });

  it("flags code that sends the deprecated model, and not code that sends another", () => {
    const draft = modelsDevDrafts(api, { today: "2026-10-30" }).find((d) => d.model === "o3-mini")!.advisory;
    const site = (model: string, line: number): CallSite => ({
      file: "src/ai.ts",
      line,
      column: 3,
      provider: "openai",
      kind: "http",
      client: "fetch",
      method: "POST",
      host: "api.openai.com",
      endpoint: "/v1/chat/completions",
      resolved: true,
      surface: { fields: [], statusCodes: [], checksOk: false, enums: [], headers: [], query: [], responseHeaders: [], body: [{ name: "model", value: model }] },
    });
    const lock = createApiLock({ callSites: [site("o3-mini", 3), site("gpt-5", 9)], declared: [] }, "test");
    const { affected } = matchAdvisories(lock, [draft], { now: new Date("2026-10-30") });
    expect(affected.map((f) => f.callSite.line)).toEqual([3]);
  });

  it("writes the drafts, and a later run keeps the day each model was first seen", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "models-dev-"));
    const source = path.join(dir, "api.json");
    writeFileSync(source, JSON.stringify(api));
    const drafts = path.join(dir, "drafts");
    let out = "";
    expect(await run(["node", "shapi-canary", "models-dev", "--source", source, "--drafts", drafts], { stdout: (s) => (out += s), stderr: () => {} }, {})).toBe(0);
    expect(out).toContain("4 new drafts");
    expect(readdirSync(drafts).sort()).toEqual(["anthropic-claude-3-opus-deprecated.json", "google-gemini-gemini-2-5-flash-image-deprecated.json", "openai-gpt-4-deprecated.json", "openai-o3-mini-deprecated.json"]);
    // Pretend the first run was earlier: the next run keeps that date.
    const file = path.join(drafts, "openai-o3-mini-deprecated.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), firstObserved: "2026-09-01", effectiveDate: "2026-09-01" }));
    out = "";
    await run(["node", "shapi-canary", "models-dev", "--source", source, "--drafts", drafts], { stdout: (s) => (out += s), stderr: () => {} }, {});
    expect(out).toContain("0 new drafts");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ firstObserved: "2026-09-01", effectiveDate: "2026-09-01" });
  });
});
