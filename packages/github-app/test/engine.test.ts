import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { loadAdvisories, type Advisory } from "@shapi/core";
import {
  DEFAULT_PR_LIMITS,
  FIX_TRAILER,
  STOP_LABEL,
  parseDashboard,
  planFixPrs,
  renderDashboard,
  upsertDashboard,
  upsertFixPr,
  type ExistingFixPr,
  type PlanInput,
} from "@shapi/github-app";
import { fakeRepoGitHub } from "../../../test-utils/fake-github";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const real = loadAdvisories(path.join(root, "advisories"));
const base = real.find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const advisory = (id: string, severity: Advisory["severity"], effectiveDate = "2026-01-01"): Advisory => ({ ...base, id, title: `Change ${id}`, severity, effectiveDate });

const plan = (over: Partial<PlanInput>) =>
  planFixPrs({
    candidates: [],
    existing: new Map(),
    openCount: 0,
    createdLastHour: 0,
    limits: DEFAULT_PR_LIMITS,
    paused: false,
    createNow: new Set(),
    retry: new Set(),
    ...over,
  }).map((d) => [d.advisory.id, d.action, d.reason]);

describe("PR policy", () => {
  const candidates = [advisory("low-1", "low"), advisory("crit-1", "critical"), advisory("high-1", "high"), advisory("high-0", "high", "2025-06-01")];

  it("opens the most urgent fixes first, up to the hourly limit; the rest wait", () => {
    expect(plan({ candidates })).toEqual([
      ["crit-1", "create", undefined],
      ["high-0", "create", undefined],
      ["high-1", "wait", "hourly PR limit (2) reached"],
      ["low-1", "wait", "hourly PR limit (2) reached"],
    ]);
  });

  it("respects the open limit and earlier PRs this hour", () => {
    expect(plan({ candidates, openCount: 9, limits: { hourly: 5, open: 10 } }).map((d) => d[1])).toEqual(["create", "wait", "wait", "wait"]);
    expect(plan({ candidates, createdLastHour: 2 }).map((d) => d[1])).toEqual(["wait", "wait", "wait", "wait"]);
  });

  it("keeps open PRs updated without using up limits, and never reopens what a maintainer closed", () => {
    const existing = new Map<string, ExistingFixPr>([
      ["crit-1", { state: "open", stopped: false }],
      ["high-0", { state: "closed", stopped: false }],
      ["high-1", { state: "open", stopped: true }],
      ["low-1", { state: "merged", stopped: false }],
    ]);
    expect(plan({ candidates, existing, openCount: 2, createdLastHour: 1 })).toEqual([
      ["crit-1", "update", undefined],
      ["high-0", "skip", "closed without merging"],
      ["high-1", "skip", "updates stopped on this PR"],
      ["low-1", "create", undefined],
    ]);
  });

  it("dashboard ticks open a fix now (past the limits) or retry a closed one; pause stops everything", () => {
    const existing = new Map<string, ExistingFixPr>([["high-0", { state: "closed", stopped: false }]]);
    const ticked = plan({ candidates, existing, createdLastHour: 2, createNow: new Set(["low-1"]), retry: new Set(["high-0"]) });
    expect(ticked.filter((d) => d[1] === "create").map((d) => d[0])).toEqual(["high-0", "low-1"]);
    expect(plan({ candidates, paused: true }).every((d) => d[1] === "wait" && d[2] === "paused from the dashboard")).toBe(true);
    expect(plan({ candidates, paused: true, pausedReason: "paused from the web app" }).every((d) => d[2] === "paused from the web app")).toBe(true);
  });
});

describe("dashboard", () => {
  const input = {
    open: [{ advisory: advisory("a", "high"), number: 4, url: "https://github.com/acme/demo/pull/4" }],
    waiting: [{ advisory: advisory("b", "low"), reason: "hourly PR limit (2) reached" }],
    closed: [{ advisory: advisory("c", "medium"), number: 2, url: "https://github.com/acme/demo/pull/2" }],
    manual: [{ advisory: advisory("d", "low"), callSites: 3 }],
    upcoming: [{ advisory: advisory("e", "low"), daysUntil: 12 }],
    paused: false,
    limits: DEFAULT_PR_LIMITS,
  };

  it("renders every section with checkboxes, and reads ticked ones back", () => {
    const body = renderDashboard(input);
    expect(body).toContain("Change a [#4](https://github.com/acme/demo/pull/4)");
    expect(body).toContain("- [ ] <!-- shapi:create:b --> Change b (hourly PR limit (2) reached)");
    expect(body).toContain("- [ ] <!-- shapi:retry:c --> Change c [#2]");
    expect(body).toContain("Change d: 3 call sites.");
    expect(body).toContain("in 12 days");
    expect(body).toContain("Limits: 2 new PRs per hour");
    expect(renderDashboard({ ...input, limits: { hourly: 1, open: 10 } })).toContain("Limits: 1 new PR per hour");
    expect(parseDashboard(body)).toEqual({ createNow: new Set(), retry: new Set(), paused: false });

    const ticked = body.replace("- [ ] <!-- shapi:create:b -->", "- [x] <!-- shapi:create:b -->").replace("- [ ] <!-- shapi:pause -->", "- [X] <!-- shapi:pause -->").replace("- [ ] <!-- shapi:retry:c -->", "- [x] <!-- shapi:retry:c -->");
    expect(parseDashboard(ticked)).toEqual({ createNow: new Set(["b"]), retry: new Set(["c"]), paused: true });
    expect(renderDashboard({ ...input, paused: true })).toContain("- [x] <!-- shapi:pause -->");
    expect(renderDashboard({ ...input, pausedFromWeb: true })).toContain("paused on this repository from the SHAPI web app");
    expect(renderDashboard(input)).not.toContain("SHAPI web app");
  });

  it("creates the issue once, updates only on change, and leaves a closed dashboard closed", async () => {
    const { fetch, github } = fakeRepoGitHub("acme/demo", { "README.md": "hi" });
    const octokit = new Octokit({ auth: "t", request: { fetch } });
    const target = { owner: "acme", repo: "demo" };
    const first = await upsertDashboard(octokit, target, "<!-- shapi-dashboard -->\none\n");
    expect(first.action).toBe("created");
    expect(github.issues[0]!.title).toBe("SHAPI Dashboard");
    expect((await upsertDashboard(octokit, { ...target, issueNumber: first.number }, "<!-- shapi-dashboard -->\none\n")).action).toBe("unchanged");
    expect((await upsertDashboard(octokit, { ...target, issueNumber: first.number }, "<!-- shapi-dashboard -->\ntwo\n")).action).toBe("updated");
    github.issues[0]!.state = "closed";
    expect((await upsertDashboard(octokit, { ...target, issueNumber: first.number }, "<!-- shapi-dashboard -->\nthree\n")).action).toBe("closed");
    expect(github.issues[0]!.body).toContain("two");
  });
});

describe("upsertFixPr", () => {
  const setup = () => {
    const fake = fakeRepoGitHub("acme/demo", { "src/deploy.ts": "old\n" });
    return { ...fake, octokit: new Octokit({ auth: "t", request: { fetch: fake.fetch } }) };
  };
  const fix = (content: string, body = "body") => ({
    repo: "acme/demo",
    branch: "shapi/change-a",
    title: "SHAPI: change a",
    body,
    commitMessage: "fix: change a",
    files: [{ path: "src/deploy.ts", content }],
    labels: ["shapi"],
  });

  it("opens a labeled PR whose commit carries the SHAPI trailer; a rerun changes nothing", async () => {
    const { octokit, github } = setup();
    const created = await upsertFixPr(octokit, fix("new\n"));
    expect(created).toMatchObject({ action: "created", number: 1, branch: "shapi/change-a" });
    expect(github.pulls[0]!.labels).toEqual([{ name: "shapi" }]);
    expect(github.commits.get(github.refs.get("shapi/change-a")!)!.message).toBe(`fix: change a\n\n${FIX_TRAILER}: shapi/change-a`);
    expect(github.fileAt("shapi/change-a", "src/deploy.ts")).toBe("new\n");

    const writes = github.calls.length;
    const again = await upsertFixPr(octokit, fix("new\n"));
    expect(again).toMatchObject({ action: "unchanged", number: 1 });
    expect(github.calls.slice(writes).filter((c) => c.method !== "GET")).toEqual([]);
    expect(github.pulls).toHaveLength(1);
  });

  it("regenerates the branch and refreshes the PR when the fix changes", async () => {
    const { octokit, github } = setup();
    await upsertFixPr(octokit, fix("new\n"));
    const updated = await upsertFixPr(octokit, fix("newer\n", "new body"));
    expect(updated).toMatchObject({ action: "updated", number: 1 });
    expect(github.fileAt("shapi/change-a", "src/deploy.ts")).toBe("newer\n");
    expect(github.pulls[0]!.body).toBe("new body");
    expect(github.pulls).toHaveLength(1);
  });

  it("regenerates an unchanged fix when its PR conflicts with the base, and never 404s looking up a new branch", async () => {
    const { octokit, github } = setup();
    await upsertFixPr(octokit, fix("new\n"));
    expect(github.calls.some((c) => c.path.includes("/git/ref/heads/shapi/"))).toBe(false);
    const before = github.refs.get("shapi/change-a");
    github.pulls[0]!.mergeable = false;
    expect(await upsertFixPr(octokit, fix("new\n"))).toMatchObject({ action: "updated" });
    expect(github.refs.get("shapi/change-a")).not.toBe(before);
    github.pulls[0]!.mergeable = null; // still computing: treated as fine
    expect(await upsertFixPr(octokit, fix("new\n"))).toMatchObject({ action: "unchanged" });
  });

  it("never overwrites a branch someone else pushed to, or a PR with the stop label", async () => {
    const { octokit, github } = setup();
    await upsertFixPr(octokit, fix("new\n"));
    github.pushAs("shapi/change-a", "src/deploy.ts", "human fix\n");
    expect(await upsertFixPr(octokit, fix("newer\n"))).toMatchObject({ action: "skipped", reason: "someone else pushed to the branch", state: "open" });
    expect(github.fileAt("shapi/change-a", "src/deploy.ts")).toBe("human fix\n");

    const other = setup();
    await upsertFixPr(other.octokit, fix("new\n"));
    other.github.label(1, STOP_LABEL);
    expect(await upsertFixPr(other.octokit, fix("newer\n"))).toMatchObject({ action: "skipped", reason: `labeled ${STOP_LABEL}` });
  });

  it("leaves a closed PR closed unless retried, and opens a new PR after a merge", async () => {
    const { octokit, github } = setup();
    await upsertFixPr(octokit, fix("new\n"));
    github.close(1);
    expect(await upsertFixPr(octokit, fix("new\n"))).toMatchObject({ action: "skipped", reason: "closed without merging", state: "closed", number: 1 });
    expect(await upsertFixPr(octokit, { ...fix("new\n"), retryClosed: true })).toMatchObject({ action: "created", number: 2 });

    const merged = setup();
    await upsertFixPr(merged.octokit, fix("new\n"));
    merged.github.close(1, true);
    expect(await upsertFixPr(merged.octokit, fix("again\n"))).toMatchObject({ action: "created", number: 2 });
  });

  it("does not take over a branch with the same name that SHAPI did not create", async () => {
    const { octokit, github } = setup();
    github.refs.set("shapi/change-a", github.refs.get("main")!);
    github.pushAs("shapi/change-a", "notes.md", "mine");
    expect(await upsertFixPr(octokit, fix("new\n"))).toMatchObject({ action: "skipped", reason: "a branch with this name exists and is not SHAPI's" });
    expect(github.pulls).toEqual([]);
  });
});
