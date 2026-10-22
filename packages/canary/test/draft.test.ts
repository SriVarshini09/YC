import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";
import { ShapeStore, diffShapes, inferShape, providerSalt } from "@shapi/shapes";
import { draftAdvisory, loadRecording, replay, run, writeDraft } from "@shapi/canary";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const recordingFile = path.join(root, "fixtures", "recordings", "github-workflow-dispatch-204-to-200.json");
const tmp = mkdtempSync(path.join(os.tmpdir(), "shapi-drafts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function replayedDraft() {
  const store = ShapeStore.open(":memory:");
  const result = replay(loadRecording(recordingFile), store, "test");
  store.close();
  return draftAdvisory({ before: result.before!, after: result.after, diff: result.diff! })!;
}

describe("draft advisory from the replayed GitHub incident", () => {
  const draft = replayedDraft();
  const seeded = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;

  it("matches the seeded advisory in substance", () => {
    for (const key of ["provider", "endpoint", "changeClass", "trigger", "severity", "firstObserved", "effectiveDate", "publishedNotice"] as const) {
      expect(draft[key], key).toEqual(seeded[key]);
    }
    expect(draft).toMatchObject({
      id: "github-workflows-dispatches-status-code-20251219",
      title: "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches returns 200 instead of 204",
      status: "unverified",
      evidence: {
        source: "replay",
        before: { observedAt: "2025-12-18T21:00:00Z", status: 204 },
        after: { observedAt: "2025-12-19T09:00:00Z", status: 200 },
      },
    });
    expect(draft.migrationNote).toContain("Accept 200 as well as 204");
  });

  it("is flagged by the Milestone 1 matcher in fixtures/demo-ts", () => {
    const lock = createApiLock(extractCallSites(path.join(root, "fixtures", "demo-ts")), "test");
    const { affected } = matchAdvisories(lock, [draft], { now: new Date("2026-10-21") });
    expect(affected).toHaveLength(1);
    expect(affected[0]).toMatchObject({
      callSite: { file: "src/deploy.ts", line: 13 },
      reasons: ["compares the response status to 204"],
    });
  });

  it("writes a file that loads as a valid advisory", () => {
    const dir = path.join(tmp, "written");
    const file = writeDraft(draft, dir);
    expect(path.basename(file)).toBe(`${draft.id}.json`);
    expect(loadAdvisories(dir).map((a) => a.id)).toEqual([draft.id]);
  });
});

describe("draftAdvisory", () => {
  const salt = providerSalt("stripe", "test");
  const observe = (observedAt: string, status: number, body: unknown) => {
    const store = ShapeStore.open(":memory:");
    const stored = store.record({
      provider: "stripe",
      method: "GET",
      endpoint: "/v1/customers/{id}",
      observedAt,
      source: "canary:stripe",
      shape: inferShape({ status, headers: {}, body: JSON.stringify(body) }, { salt }),
    });
    store.close();
    return stored;
  };

  it("drafts field changes with a fields trigger", () => {
    const before = observe("2026-10-01T00:00:00Z", 200, { id: "cus_1", tax_exempt: "none", address: { country: "US" } });
    const after = observe("2026-10-02T00:00:00Z", 200, { id: "cus_1", tax_exempt: "none" });
    const draft = draftAdvisory({ before, after, diff: diffShapes(before.shape, after.shape) });
    expect(draft).toMatchObject({
      id: "stripe-v1-customers-field-rename-20261002",
      changeClass: "field-rename",
      severity: "high",
      trigger: { fields: ["address"] },
      sources: ["https://docs.stripe.com/api"],
    });
  });

  it("returns undefined when nothing breaking changed", () => {
    const before = observe("2026-10-01T00:00:00Z", 200, { id: "cus_1" });
    const after = observe("2026-10-02T00:00:00Z", 200, { id: "cus_1", extra: true });
    expect(draftAdvisory({ before, after, diff: diffShapes(before.shape, after.shape) })).toBeUndefined();
  });
});

describe("shapi-canary replay --drafts", () => {
  it("writes the draft advisory into the drafts directory", async () => {
    const dir = path.join(tmp, "cli");
    let out = "";
    const code = await run(["node", "shapi-canary", "replay", recordingFile, "--drafts", dir], { stdout: (s) => (out += s), stderr: () => {} }, {});
    expect(code).toBe(0);
    expect(out).toContain("draft advisory: ");
    expect(readdirSync(dir)).toEqual(["github-workflows-dispatches-status-code-20251219.json"]);
  });
});
