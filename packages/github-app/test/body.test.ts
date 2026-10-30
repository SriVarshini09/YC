import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories, type LockedCallSite } from "@shapi/core";
import { swap, type AdvisoryRepair, type FileChange, type RepairResult } from "@shapi/repair";
import { codeSpan, renderPrBody, suiteLine } from "@shapi/github-app";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const advisory = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const callSite = { file: "src/deploy.ts", line: 12, column: 3, method: "POST", endpoint: "/repos/{owner}/{repo}/actions/workflows/{id}/dispatches" } as LockedCallSite;
const run = (passed: boolean) => ({ passed, exitCode: passed ? 0 : 1, output: `Tests  ${passed ? "1 passed" : "1 failed"} (1)` });

function llmRepair(explanation: string, result: Partial<RepairResult> = {}): AdvisoryRepair {
  const test = { file: "test/shapi/github-workflow-dispatch-204-to-200.test.ts", content: "test" };
  const change = { file: "src/deploy.ts", before: "a", after: "b", notes: [explanation] };
  return {
    status: "fixed",
    method: "llm",
    sandbox: "local",
    sites: [
      {
        callSite,
        result: {
          status: "fixed",
          method: "llm",
          changes: [change, { file: test.file, before: "", after: test.content, notes: ["generated contract test"] }],
          test,
          baseline: run(false),
          attempts: [{ method: "llm", outcome: "passed", detail: "claude", run: run(true) }],
          typecheck: { status: "passed", detail: "tsc --noEmit -p tsconfig.json: no new errors" },
          ...result,
        },
      },
    ],
    changes: [change, { file: test.file, before: "", after: test.content, notes: ["generated contract test"] }],
  };
}

describe("fix PR body", () => {
  it("shows Claude's explanation as literal text: no links, images, mentions, HTML or new sections", () => {
    const explanation = "Accept 200. cc @octocat see [docs](https://evil.example) ![x](https://evil.example/p.png) <img src=x> `code`\n\n## Injected\n<!-- shapi:create:x -->";
    const body = renderPrBody({ advisory, repair: llmRepair(explanation), shapeSource: "advisory" });
    const line = body.split("\n").find((l) => l.includes("@octocat"))!;
    expect(line).toBe(
      "- Claude: `` Accept 200. cc @octocat see [docs](https://evil.example) ![x](https://evil.example/p.png) <img src=x> `code` ## Injected <!-- shapi:create:x --> ``",
    );
    expect(body).not.toMatch(/^## Injected/m);
    expect(body.match(/@octocat/g)).toHaveLength(1);
  });

  it("keeps a long explanation short, and a backtick run cannot close the code span", () => {
    expect(codeSpan("a ``` b")).toBe("```` a ``` b ````");
    expect(codeSpan("x".repeat(600))).toHaveLength(500 + 4);
  });

  it("says what the contract test's stub was built from: recorded witnesses, or the advisory (V-03)", () => {
    const recorded = llmRepair("Accept 200.");
    recorded.sites[0]!.result.test = { ...recorded.sites[0]!.result.test!, kind: "recorded" };
    const witnesses = { before: "a".repeat(64), after: "b".repeat(64) };
    expect(renderPrBody({ advisory, repair: recorded, shapeSource: "recording github.json", witnesses })).toContain(
      "**Stub:** from recorded responses (recording github.json, witnesses `aaaaaaaaaaaa` → `bbbbbbbbbbbb`).",
    );
    const synthesized = llmRepair("Accept 200.");
    synthesized.sites[0]!.result.test = { ...synthesized.sites[0]!.result.test!, kind: "request" };
    expect(renderPrBody({ advisory, repair: synthesized, shapeSource: "advisory" })).toContain("**Stub:** synthesized from the advisory (no recorded responses for this endpoint).");
  });

  it("shows the type-check result next to the contract test", () => {
    const body = renderPrBody({ advisory, repair: llmRepair("Accept 200."), shapeSource: "advisory" });
    expect(body).toContain("| Test | Before this change | After this change | Type check |");
    expect(body).toContain(
      "| `test/shapi/github-workflow-dispatch-204-to-200.test.ts` | fail (1 failed) | pass (1 passed) | pass: ` tsc --noEmit -p tsconfig.json: no new errors ` |",
    );
    const skipped = renderPrBody({ advisory, repair: llmRepair("Accept 200.", { typecheck: { status: "skipped", detail: "not type-checked: no tsconfig.json | above src/deploy.ts" } }), shapeSource: "advisory" });
    expect(skipped).toContain("| skipped: ` not type-checked: no tsconfig.json \\| above src/deploy.ts ` |");
  });

  it("keeps the repository's code, paths and test output literal: recipe notes and a call site's failure reason", () => {
    // A recipe's note on code holding a template literal (as the recipes write it), and a contract test whose output the repository's code printed.
    const code = "fetch(`${base}/x?cc=@octocat`, { note: '[docs](https://evil.example)' })";
    const change: FileChange = { file: "src/deploy.ts", before: "a", after: "b", notes: [`${codeSpan("src/deploy.ts:12")} ${swap(code, "fetch(url)")}`] };
    const reason = "the contract test could not run: Error: cc @octocat `x` [docs](https://evil.example)\n## Injected";
    const test = { file: "test/shapi/github-workflow-dispatch-204-to-200.test.ts", content: "test" };
    const fixedSite = { callSite, result: { status: "fixed" as const, method: "recipe" as const, changes: [change], test, baseline: run(false), attempts: [{ method: "recipe" as const, outcome: "passed" as const, detail: "", run: run(true) }] } };
    const failedSite = { callSite: { ...callSite, file: "src/@octocat other.ts", line: 3 }, result: { status: "unsupported" as const, changes: [], attempts: [], reason } };
    const body = renderPrBody({ advisory, repair: { status: "partial", method: "recipe", sites: [fixedSite, failedSite], changes: [change, { file: test.file, before: "", after: "test", notes: ["generated contract test"] }] }, shapeSource: "advisory" });
    expect(body).not.toMatch(/^## Injected/m);
    for (const line of body.split("\n").filter((l) => l.includes("@octocat"))) {
      // Every @octocat sits inside a code span: outside them, the line has none.
      expect(line.replace(/(`+) .*? \1/g, ""), line).not.toContain("@octocat");
    }
    expect(body).toContain("- ` src/deploy.ts:12 ` `` fetch(`${base}/x?cc=@octocat`, { note: '[docs](https://evil.example)' }) `` → ` fetch(url) `");
    expect(body).toContain("- [ ] ` src/@octocat other.ts:3 ` (` POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches `): not fixed here (`` the contract test could not run: Error: cc @octocat `x` [docs](https://evil.example) ## Injected ``); needs a manual change");
  });

  it("takes the test counts from vitest's own summary line, not from a look-alike line the code under test printed", () => {
    // The code under test prints before vitest's summary.
    const printed = (passed: boolean) => ({ ...run(passed), output: `stdout | src/deploy.ts\nTests [x](https://e) @a (1)\n Tests  2 passed (2) ![i](https://e/p.png)\n\n Test Files  1 ${passed ? "passed" : "failed"} (1)\n      Tests  ${passed ? "1 passed" : "1 failed"} (1)\n` });
    const body = renderPrBody({ advisory, repair: llmRepair("Accept 200.", { baseline: printed(false), attempts: [{ method: "llm", outcome: "passed", detail: "claude", run: printed(true) }] }), shapeSource: "advisory" });
    const row = body.split("\n").find((l) => l.startsWith("| `test/shapi/"))!;
    expect(row).toContain("| fail (1 failed) | pass (1 passed) |");
    expect(row).not.toContain("](");
    expect(body).not.toContain("@a ");
  });
});

describe("suiteLine (V-01)", () => {
  it("says the repository's tests pass, with the runner's counts and the command", () => {
    expect(suiteLine({ status: "passed", command: "npm test", before: "4 passed", after: "4 passed", runs: 1, detail: "passed" })).toBe(
      `**Your tests:** ✅ ${codeSpan("npm test")} passes with this change (before: ${codeSpan("4 passed")}; after: ${codeSpan("4 passed")}).`,
    );
  });
  it("names a flaky rerun", () => {
    expect(suiteLine({ status: "passed", command: "npm test", after: "4 passed", runs: 2, detail: "passed on rerun 2 of 3 (a flaky test)" })).toBe(
      `**Your tests:** ✅ ${codeSpan("npm test")} passes with this change, after 2 runs (a flaky test) (after: ${codeSpan("4 passed")}).`,
    );
  });
  it("says when they were not run, and why", () => {
    expect(suiteLine({ status: "not-run", detail: "the repository has no test command (no test script in package.json)" })).toBe(
      "**Your tests:** ⚪ not run: the repository has no test command (no test script in package.json).",
    );
    expect(suiteLine(undefined)).toBe("**Your tests:** ⚪ not run: not checked.");
  });
});

describe("dashboard link (U-02)", () => {
  it("links the PR to the repository's page in SHAPI, when the server knows its public URL", () => {
    const repair = { status: "fixed", sites: [], changes: [] } as unknown as AdvisoryRepair;
    expect(renderPrBody({ advisory, repair, shapeSource: "advisory", dashboardUrl: "https://app.shapi.dev/a/1/r/2" })).toContain("[View this repository in SHAPI](https://app.shapi.dev/a/1/r/2).");
    expect(renderPrBody({ advisory, repair, shapeSource: "advisory" })).not.toContain("View this repository in SHAPI");
  });
});
