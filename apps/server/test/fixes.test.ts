import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAdvisories, type Advisory } from "@shapi/core";
import { createDb, migrateToLatest, withService, type Db } from "@shapi/db";
import { STOP_LABEL } from "@shapi/github-app";
import { fakeRepoGitHub } from "../../../test-utils/fake-github";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { deliverRepoFixes, githubClients, processDelivery, type FixCandidate } from "../src/index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const base = loadAdvisories(path.join(root, "advisories")).find((a) => a.id === "github-workflow-dispatch-204-to-200")!;
const advisory = (id: string, severity: Advisory["severity"]): Advisory => ({ ...base, id, title: `Change ${id}`, severity });
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

let pg: TestPostgres;
let db: Db;
let owner: Db;
let repositoryId: string;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_fixes");
  owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await owner?.destroy();
  await pg?.stop();
}, 60_000);

beforeEach(async () => {
  await owner.deleteFrom("accounts").execute();
  const account = await owner
    .insertInto("accounts")
    .values({ github_installation_id: 42, login: "acme", type: "Organization", settings: JSON.stringify({}) })
    .returning("id")
    .executeTakeFirstOrThrow();
  const repo = await owner
    .insertInto("repositories")
    .values({ account_id: account.id, github_repo_id: 777, full_name: "acme/demo", default_branch: "main", private: true })
    .returning("id")
    .executeTakeFirstOrThrow();
  repositoryId = repo.id;
});

function setup() {
  const fake = fakeRepoGitHub("acme/demo", { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
  const github = githubClients({ appId: "1", privateKey }, { fetch: fake.fetch, resilient: false });
  return { ...fake, deps: { db, github } };
}

const candidate = (a: Advisory, file: string, content = `fixed ${a.id}\n`): FixCandidate => ({
  advisory: a,
  title: `SHAPI: ${a.title}`,
  body: `Fixes ${a.id}`,
  commitMessage: `fix: ${a.title}`,
  files: [{ path: file, content }],
});

const crit = advisory("crit", "critical");
const high = advisory("high", "high");
const low = advisory("low", "low");
const fixes = [candidate(low, "src/c.ts"), candidate(crit, "src/a.ts"), candidate(high, "src/b.ts")];

const rows = () => withService(db, (tx) => tx.selectFrom("fix_prs").select(["advisory_id", "number", "state", "stopped"]).orderBy("advisory_id").execute());

/** A webhook as GitHub would send it for this repository, processed by the worker. */
async function webhook(github: ReturnType<typeof setup>, event: string, payload: object) {
  const id = randomUUID();
  await db.insertInto("webhook_deliveries").values({ delivery_id: id, event, action: (payload as { action?: string }).action ?? null, installation_id: 42, payload: JSON.stringify({ ...payload, repository: { id: 777 } }) }).execute();
  return (await processDelivery(github.deps, id)).outcome;
}

describe("fix delivery", () => {
  it("opens the most urgent fixes up to the hourly limit, lists the rest on the dashboard, and is idempotent", async () => {
    const t = setup();
    const now = new Date();
    const first = await deliverRepoFixes(t.deps, { repositoryId, fixes, now, upcoming: [{ advisory: base, daysUntil: 30 }] });
    expect(first.outcomes.map((o) => [o.advisoryId, o.action])).toEqual([
      ["crit", "created"],
      ["high", "created"],
      ["low", "wait"],
    ]);
    expect(t.github.pulls.map((p) => [p.number, p.head.ref, p.labels.map((l) => l.name)])).toEqual([
      [1, "shapi/crit", ["shapi"]],
      [2, "shapi/high", ["shapi"]],
    ]);
    expect(await rows()).toEqual([
      { advisory_id: "crit", number: 1, state: "open", stopped: false },
      { advisory_id: "high", number: 2, state: "open", stopped: false },
    ]);
    const dashboard = t.github.issues[0]!;
    expect(first.dashboard).toEqual({ number: dashboard.number, action: "created" });
    expect(dashboard.body).toContain("<!-- shapi:create:low --> Change low (hourly PR limit (2) reached)");
    expect(dashboard.body).toContain("Upcoming deadlines");

    // a rerun in the same hour: nothing new, nothing rewritten
    const second = await deliverRepoFixes(t.deps, { repositoryId, fixes, now, upcoming: [{ advisory: base, daysUntil: 30 }] });
    expect(second.outcomes.map((o) => o.action)).toEqual(["unchanged", "unchanged", "wait"]);
    expect(second.dashboard!.action).toBe("unchanged");
    expect(t.github.pulls).toHaveLength(2);
  });

  it("a ticked box opens a waiting fix now; the next hour opens the rest anyway", async () => {
    const t = setup();
    const now = new Date();
    const first = await deliverRepoFixes(t.deps, { repositoryId, fixes, now });
    t.github.tick(first.dashboard!.number, "create:low");
    const second = await deliverRepoFixes(t.deps, { repositoryId, fixes, now });
    expect(second.outcomes.find((o) => o.advisoryId === "low")!.action).toBe("created");
    expect(t.github.issues[0]!.body).not.toContain("shapi:create:low");
    expect(t.github.issues[0]!.body).toContain("Change low [#4]");
  });

  it("follows maintainers: closed stays closed until retried, merged is recorded, stop label halts updates", async () => {
    const t = setup();
    const now = new Date();
    await deliverRepoFixes(t.deps, { repositoryId, fixes, now });

    t.github.close(1);
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { ...t.github.pulls[0]!, merged: false } })).toBe("fix PR #1 closed");
    t.github.close(2, true);
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { ...t.github.pulls[1]!, merged: true } })).toBe("fix PR #2 closed");
    expect((await rows()).map((r) => [r.advisory_id, r.state])).toEqual([
      ["crit", "closed"],
      ["high", "merged"],
    ]);

    const later = new Date(now.getTime() + 2 * 3600_000);
    const run = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts"), candidate(low, "src/c.ts")], now: later });
    expect(run.outcomes.map((o) => [o.advisoryId, o.action, o.reason])).toEqual([
      ["crit", "skip", "closed without merging"],
      ["low", "created", undefined],
    ]);
    const dashboard = t.github.issues[0]!;
    expect(dashboard.body).toContain("<!-- shapi:retry:crit --> Change crit [#1]");

    // ticking retry reopens it as a new PR
    t.github.tick(dashboard.number, "retry:crit");
    const retried = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts"), candidate(low, "src/c.ts")], now: later });
    expect(retried.outcomes.find((o) => o.advisoryId === "crit")).toMatchObject({ action: "created" });

    // the stop label: recorded from the webhook, then the PR is left alone
    const lowPr = t.github.pulls.find((p) => p.head.ref === "shapi/low")!;
    t.github.label(lowPr.number, STOP_LABEL);
    expect(await webhook(t, "pull_request", { action: "labeled", pull_request: { ...lowPr, merged: false } })).toMatch(/labeled/);
    expect((await rows()).find((r) => r.advisory_id === "low")!.stopped).toBe(true);
    const stopped = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(low, "src/c.ts", "changed\n")], now: later });
    expect(stopped.outcomes[0]).toMatchObject({ action: "skip", reason: "updates stopped on this PR" });
    expect(t.github.fileAt("shapi/low", "src/c.ts")).toBe("fixed low\n");
  });

  it("pause on the dashboard stops all changes; dashboard edits arrive by webhook, bot edits are ignored", async () => {
    const t = setup();
    const now = new Date();
    const first = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now });
    const issue = t.github.issues[0]!;
    t.github.tick(issue.number, "pause");

    expect(await webhook(t, "issues", { action: "edited", issue, sender: { type: "Bot" } })).toBe("ignored: edited by a bot");
    expect(await webhook(t, "issues", { action: "edited", issue, sender: { type: "User" } })).toBe("dashboard saved (paused: true, open now: 0, retry: 0)");
    const saved = await withService(db, (tx) => tx.selectFrom("repositories").select("settings").where("id", "=", repositoryId).executeTakeFirstOrThrow());
    expect(saved.settings).toEqual({ paused: true, createNow: [], retry: [] });

    const paused = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts", "different\n"), candidate(high, "src/b.ts")], now });
    expect(paused.outcomes.map((o) => o.action)).toEqual(["wait", "wait"]);
    expect(t.github.fileAt("shapi/crit", "src/a.ts")).toBe("fixed crit\n");
    expect(t.github.pulls).toHaveLength(1);
    expect(t.github.issues[0]!.body).toContain("- [x] <!-- shapi:pause -->");
    expect(first.dashboard!.number).toBe(issue.number);
  });

  it("ignores PR events for branches SHAPI does not own", async () => {
    const t = setup();
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { number: 9, html_url: "x", merged: false, head: { ref: "feature/x", sha: "s" }, labels: [] } })).toBe("ignored: not a SHAPI branch");
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { number: 9, html_url: "x", merged: false, head: { ref: "shapi/unknown", sha: "s" }, labels: [] } })).toBe("ignored: not a PR SHAPI opened");
  });
});
