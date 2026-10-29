import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAdvisories, type LockedCallSite } from "@shapi/core";
import type { AdvisoryRepair, RepairResult } from "@shapi/repair";
import { codeSpan, renderPrBody } from "@shapi/github-app";

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

  it("shows the type-check result next to the contract test", () => {
    const body = renderPrBody({ advisory, repair: llmRepair("Accept 200."), shapeSource: "advisory" });
    expect(body).toContain("| Test | Before this change | After this change | Type check |");
    expect(body).toContain(
      "| `test/shapi/github-workflow-dispatch-204-to-200.test.ts` | fail (1 failed) | pass (1 passed) | pass: ` tsc --noEmit -p tsconfig.json: no new errors ` |",
    );
    const skipped = renderPrBody({ advisory, repair: llmRepair("Accept 200.", { typecheck: { status: "skipped", detail: "not type-checked: no tsconfig.json | above src/deploy.ts" } }), shapeSource: "advisory" });
    expect(skipped).toContain("| skipped: ` not type-checked: no tsconfig.json \\| above src/deploy.ts ` |");
  });
});
