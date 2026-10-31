import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createApiLock, type CallSite } from "@shapi/core";
import { extractCallSites, loadGoParser } from "@shapi/extractor";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "go");

let sites: CallSite[] = [];
beforeAll(async () => {
  await loadGoParser();
  sites = extractCallSites(fixture).callSites;
});

describe("Go call sites (U-07)", () => {
  it("finds net/http requests, with URLs from constants, fmt.Sprintf, + and locals", () => {
    expect(sites.map((s) => `${s.file}:${s.line} ${s.provider} ${s.method} ${s.endpoint} ${s.resolved}`)).toMatchSnapshot();
  });

  it("records what the code depends on in the response", () => {
    expect(sites.map((s) => s.surface)).toMatchSnapshot();
  });

  it("writes an api.lock for a Go repository", () => {
    const lock = createApiLock({ callSites: sites, declared: [] }, "test");
    expect(lock).toMatchSnapshot();
  });
});
