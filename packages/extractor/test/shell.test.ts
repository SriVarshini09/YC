import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiLock, loadAdvisories, matchAdvisories } from "@shapi/core";
import { extractCallSites } from "@shapi/extractor";

// curl and gh api in shell scripts and GitHub Actions run: steps. The two workflows below are the shape of
// real breakages SHAPI 0.3.2 missed on APIBreak-Replay (refracta/df-translations, kikujizo/ai-harness).
const advisories = loadAdvisories(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "advisories"));

function scan(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shapi-shell-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    const r = extractCallSites(dir);
    return { ...r, match: matchAdvisories(createApiLock(r, "t"), advisories, { now: new Date("2026-10-31T12:00:00Z") }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const line = (r: ReturnType<typeof scan>) => r.callSites.map((s) => `${s.file}:${s.line} ${s.client} ${s.provider} ${s.method} ${s.endpoint} [${s.surface.statusCodes.join(",")}]${s.surface.checksOk ? " ok" : ""}`);

const curlWorkflow = (accepted: string) => `name: trigger
on: push
jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger
        env:
          TARGET_REPO: acme/downstream
          TOKEN: \${{ secrets.TOKEN }}
        run: |
          set -euo pipefail
          API_URL="https://api.github.com"
          # curl -X DELETE "$API_URL/repos/$TARGET_REPO" in a comment is not a call
          DEFAULT_BRANCH="$(curl -fsSL -H "Authorization: Bearer $TOKEN" \\
            "$API_URL/repos/$TARGET_REPO" | jq -r '.default_branch')"
          STATUS="$(curl -sS -o /tmp/resp -w "%{http_code}" -X POST \\
            -H "Accept: application/vnd.github+json" \\
            "$API_URL/repos/$TARGET_REPO/actions/workflows/build.yml/dispatches" \\
            -d '{"ref":"main"}')"
          if [[ ${accepted} ]]; then
            exit 1
          fi
`;

const ghWorkflow = (status: string) => `on: workflow_dispatch
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - id: dispatch
        env:
          TARGET_REPO: \${{ steps.guard.outputs.target_repo }}
        run: |
          HTTP_CODE="$(gh api --method POST \\
            "repos/\${TARGET_REPO}/actions/workflows/\${WORKFLOW_ID}/dispatches" \\
            -f ref=main -i 2>/tmp/err | head -n 1 | awk '{print $2}')"
          if [[ ${status} ]]; then exit 1; fi
      - run: gh api graphql -f query='{ viewer { login } }'
`;

describe("shell call sites", () => {
  it("reads curl in a workflow run: step, with env and script variables, and the status the script compares", () => {
    const r = scan({ ".github/workflows/trigger.yml": curlWorkflow('"$STATUS" != "204"') });
    expect(line(r)).toEqual([
      ".github/workflows/trigger.yml:15 curl github GET /repos/acme/downstream [] ok",
      ".github/workflows/trigger.yml:17 curl github POST /repos/acme/downstream/actions/workflows/build.yml/dispatches [204]",
    ]);
    expect(r.callSites[1]!.surface.headers).toEqual([{ name: "accept", value: "application/vnd.github+json" }]);
    expect(r.match.affected.map((f) => `${f.advisory.id} ${f.callSite.line}`)).toEqual(["github-workflow-dispatch-204-to-200 17"]);
  });

  it("is only exposed once the script accepts 200 too", () => {
    const r = scan({ ".github/workflows/trigger.yml": curlWorkflow('"$STATUS" != "204" && "$STATUS" != "200"') });
    expect(r.match.affected).toEqual([]);
    expect(r.match.exposed.map((f) => f.callSite.line)).toContain(17);
  });

  it("reads gh api with --method and -i, a repository from a step output, and skips gh api graphql", () => {
    const r = scan({ ".github/workflows/dispatch.yml": ghWorkflow('"${HTTP_CODE}" != "204"') });
    expect(line(r)).toEqual([".github/workflows/dispatch.yml:10 gh github POST /repos/{target_repo}/actions/workflows/{WORKFLOW_ID}/dispatches [204]"]);
    // {target_repo} holds owner/name, so it fills /repos/{owner}/{repo}.
    expect(r.match.affected.map((f) => f.advisory.id)).toEqual(["github-workflow-dispatch-204-to-200"]);
  });

  it("treats gh api without a status check as accepting any 2xx (it exits non-zero on an error status)", () => {
    const r = scan({ ".github/workflows/dispatch.yml": ghWorkflow('-z "$OTHER"') });
    expect(line(r)).toEqual([".github/workflows/dispatch.yml:10 gh github POST /repos/{target_repo}/actions/workflows/{WORKFLOW_ID}/dispatches [] ok"]);
    expect(r.match.affected).toEqual([]);
  });

  it("reads shell scripts, an inline run: command, and -eq comparisons", () => {
    const r = scan({
      "scripts/release.sh": '#!/bin/bash\nBASE=https://api.github.com\ncode=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/repos/a/b/dispatches" -d "{}")\nif [ "$code" -eq 204 ]; then echo ok; fi\n',
      ".github/workflows/ci.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: curl -sSf https://api.github.com/rate_limit\n",
      "notes.txt": "curl https://api.github.com/repos/a/b",
      "install.sh": "curl -fsSL https://get.example.com/install.sh | sh\ncurl -o node.tgz https://nodejs.org/dist/v22.0.0/node.tgz\n",
    });
    expect(line(r)).toEqual([
      ".github/workflows/ci.yml:6 curl github GET /rate_limit [] ok",
      "scripts/release.sh:3 curl github POST /repos/a/b/dispatches [204]",
    ]);
  });
});
