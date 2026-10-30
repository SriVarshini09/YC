import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadAdvisories, type Advisory } from "@shapi/core";
import { createDb, migrateToLatest, withService, withTenant, type Db } from "@shapi/db";
import { STOP_LABEL } from "@shapi/github-app";
import { sql } from "kysely";
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

function setup(opts: { refuseDrafts?: boolean } = {}) {
  const fake = fakeRepoGitHub("acme/demo", { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" }, opts);
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

const repairOf = (a: Advisory): NonNullable<FixCandidate["repair"]> => ({
  method: "recipe",
  recipeId: a.recipeId,
  verifiedAt: "2026-10-23T00:00:00.000Z",
  sites: [{ file: "src/a.ts", line: 1, method: "POST", endpoint: "/x", status: "fixed", test: "test/shapi/a.test.ts", before: { passed: false, tests: "1 failed", output: "" }, after: { passed: true, tests: "1 passed", output: "" } }],
  changes: [{ file: "src/a.ts", kind: "modified", diff: "@@ -1 +1 @@\n-a\n+fixed", truncated: false }],
});

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

  it("labels a new PR needs-human when its fix asks for it (V-04: an undo the contract test survived)", async () => {
    const t = setup();
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [{ ...candidate(crit, "src/a.ts"), labels: ["needs-human"] }], now: new Date() });
    expect(t.github.pulls.map((p) => p.labels.map((l) => l.name))).toEqual([["shapi", "needs-human"]]);
  });

  it("opens a fix that edits outside its predicted lines as a draft, or a labelled PR where drafts are refused (V-05)", async () => {
    const outOfScope = { ...candidate(crit, "src/a.ts"), labels: ["needs-human"], draft: true };
    const t = setup();
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [outOfScope], now: new Date() });
    expect(t.github.pulls.map((p) => [p.draft, p.labels.map((l) => l.name)])).toEqual([[true, ["shapi", "needs-human"]]]);
    await withService(db, (tx) => tx.deleteFrom("fix_prs").execute());
    const free = setup({ refuseDrafts: true });
    await deliverRepoFixes(free.deps, { repositoryId, fixes: [outOfScope], now: new Date() });
    expect(free.github.pulls.map((p) => [p.draft, p.labels.map((l) => l.name)])).toEqual([[false, ["shapi", "needs-human"]]]);
  });

  it("stores how a fix was verified with its PR: kept by a rerun without one, rewritten by any rerun with one", async () => {
    const t = setup();
    const now = new Date();
    const withRepair = { ...candidate(crit, "src/a.ts"), repair: repairOf(crit) };
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [withRepair], now });
    const stored = () => withService(db, (tx) => tx.selectFrom("fix_prs").select(["advisory_id", "repair"]).executeTakeFirstOrThrow());
    expect((await stored()).repair).toEqual(repairOf(crit));
    // an unchanged rerun without the summary leaves the stored one alone
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now });
    expect((await stored()).repair).toEqual(repairOf(crit));
    // an unchanged rerun with a summary rewrites it: the same code, verified again
    const again = { ...candidate(crit, "src/a.ts"), repair: { ...repairOf(crit), verifiedAt: "2026-10-23T12:00:00.000Z" } };
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [again], now });
    expect((await stored()).repair?.verifiedAt).toBe("2026-10-23T12:00:00.000Z");
    // a changed fix with a new summary replaces it
    const later = new Date(now.getTime() + 3_600_000);
    const changed = { ...candidate(crit, "src/a.ts", "changed again\n"), repair: { ...repairOf(crit), verifiedAt: "2026-10-24T00:00:00.000Z" } };
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [changed], now: later });
    expect((await stored()).repair?.verifiedAt).toBe("2026-10-24T00:00:00.000Z");
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

  it("keeps a pause from the web app and a box ticked on the issue while the job was opening PRs", async () => {
    const fake = fakeRepoGitHub("acme/demo", { "src/a.ts": "a\n", "src/b.ts": "b\n", "src/c.ts": "c\n" });
    let during: (() => Promise<void>) | undefined;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const run = String(input).includes("/pulls") ? during : undefined;
      if (run) {
        during = undefined;
        await run();
      }
      return fake.fetch(input, init);
    }) as typeof globalThis.fetch;
    const deps = { db, github: githubClients({ appId: "1", privateKey }, { fetch, resilient: false }) };
    const now = new Date();
    const first = await deliverRepoFixes(deps, { repositoryId, fixes, now });
    const number = first.dashboard!.number;
    expect(fake.github.issues[0]!.body).toContain("- [ ] <!-- shapi:create:low -->");

    // The next run reads the settings and the issue, then, while it updates the open PRs, the maintainer
    // pauses SHAPI from the web app and ticks "open now" on the issue.
    during = async () => {
      await owner.updateTable("repositories").set({ settings: sql<string>`settings || '{"pausedFromWeb": true}'::jsonb` }).where("id", "=", repositoryId).execute();
      fake.github.tick(number, "create:low");
    };
    await deliverRepoFixes(deps, { repositoryId, fixes, now });
    expect(during).toBeUndefined();
    const saved = await owner.selectFrom("repositories").select("settings").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    expect(saved.settings).toEqual({ pausedFromWeb: true, paused: false, createNow: ["low"], retry: [] });
    expect(fake.github.issues[0]!.body).toContain("- [x] <!-- shapi:create:low -->");
  });

  it("a ticked box or a lifted pause queues a fix job on the latest scan right away", async () => {
    const t = setup();
    const first = await deliverRepoFixes(t.deps, { repositoryId, fixes, now: new Date() });
    const issue = t.github.issues[0]!;
    const account = await owner.selectFrom("repositories").select("account_id").where("id", "=", repositoryId).executeTakeFirstOrThrow();
    const scan = await owner
      .insertInto("scans")
      .values({ account_id: account.account_id, repository_id: repositoryId, sha: "a".repeat(40), status: "succeeded", api_lock: JSON.stringify({ callSites: [] }), finished_at: new Date() })
      .returning("id")
      .executeTakeFirstOrThrow();
    const edited = async () => {
      const id = randomUUID();
      await db.insertInto("webhook_deliveries").values({ delivery_id: id, event: "issues", action: "edited", installation_id: 42, payload: JSON.stringify({ action: "edited", issue, sender: { type: "User" }, repository: { id: 777 } }) }).execute();
      return processDelivery(t.deps, id);
    };

    t.github.tick(first.dashboard!.number, "create:low");
    const ticked = await edited();
    expect(ticked.outcome).toBe("dashboard saved (paused: false, open now: 1, retry: 0), fix job queued");
    expect(ticked.fixes).toEqual([{ scanId: scan.id, repositoryId }]);

    // Pausing asks for nothing; lifting the pause delivers what waited.
    issue.body = issue.body.replace("- [x] <!-- shapi:create:low -->", "- [ ] <!-- shapi:create:low -->");
    t.github.tick(issue.number, "pause");
    expect((await edited()).fixes).toEqual([]);
    issue.body = issue.body.replace("- [x] <!-- shapi:pause -->", "- [ ] <!-- shapi:pause -->");
    expect((await edited()).fixes).toEqual([{ scanId: scan.id, repositoryId }]);
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

  it("a fix whose branch has a maintainer's commits needs them, not a tick: the dashboard says to delete the branch", async () => {
    const t = setup();
    const now = new Date();
    // someone made shapi/crit by hand before SHAPI got to it
    t.github.refs.set("shapi/crit", t.github.refs.get("main")!);
    t.github.pushAs("shapi/crit", "src/a.ts", "theirs\n");
    const run = await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now });
    expect(run.outcomes).toEqual([{ advisoryId: "crit", action: "skipped", reason: "a branch with this name exists and is not SHAPI's", url: undefined }]);
    let body = t.github.issues[0]!.body;
    expect(body).not.toContain("## Waiting");
    expect(body).not.toContain("shapi:create:crit");
    expect(body).toContain("## Needs you\n\n- Change crit: the branch `shapi/crit` has commits that are not SHAPI's, so SHAPI leaves it alone. Delete the branch and SHAPI opens the fix on its next scan.");
    expect(t.github.fileAt("shapi/crit", "src/a.ts")).toBe("theirs\n");

    // a fix PR closed without merging, retried from the dashboard after a maintainer pushed to its branch
    t.github.refs.delete("shapi/crit");
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now });
    const closed = t.github.pulls.find((p) => p.head.ref === "shapi/crit")!;
    t.github.close(closed.number);
    t.github.pushAs("shapi/crit", "src/a.ts", "theirs again\n");
    const later = new Date(now.getTime() + 2 * 3600_000);
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now: later });
    expect(t.github.issues[0]!.body).not.toContain("You ticked this");
    // Ticked without deleting the branch: the box comes back unticked, and the row says why nothing was opened.
    t.github.tick(t.github.issues[0]!.number, "retry:crit");
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")], now: later });
    body = t.github.issues[0]!.body;
    expect(body).toContain(`## Needs you\n\n- [ ] <!-- shapi:retry:crit --> Change crit [#${closed.number}](`);
    expect(body).toContain(
      "has commits that are not SHAPI's, so SHAPI leaves it alone. You ticked this, but the branch still has those commits, so nothing was opened. Delete the branch, then tick to open the fix again.",
    );
    expect(body).not.toContain("## Closed without merging");
    expect(t.github.fileAt("shapi/crit", "src/a.ts")).toBe("theirs again\n");
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
    // the open PR stays under "Open fix PRs"; only the new fix gets an "open now" box
    expect(t.github.issues[0]!.body).not.toContain("shapi:create:crit");
    expect(t.github.issues[0]!.body).toContain("shapi:create:high");
    expect(t.github.fileAt("shapi/crit", "src/a.ts")).toBe("fixed crit\n");
    expect(t.github.pulls).toHaveLength(1);
    expect(t.github.issues[0]!.body).toContain("- [x] <!-- shapi:pause -->");
    expect(first.dashboard!.number).toBe(issue.number);
  });

  it("keeps fix PR records to their own tenant", async () => {
    const t = setup();
    await deliverRepoFixes(t.deps, { repositoryId, fixes: [candidate(crit, "src/a.ts")] });
    const other = await owner
      .insertInto("accounts")
      .values({ github_installation_id: 43, login: "other", type: "User", settings: JSON.stringify({}) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const mine = await withService(db, (tx) => tx.selectFrom("fix_prs").select("account_id").executeTakeFirstOrThrow());
    expect(await db.selectFrom("fix_prs").selectAll().execute()).toEqual([]);
    expect(await withTenant(db, other.id, (tx) => tx.selectFrom("fix_prs").selectAll().execute())).toEqual([]);
    expect(await withTenant(db, mine.account_id, (tx) => tx.selectFrom("fix_prs").select("advisory_id").execute())).toEqual([{ advisory_id: "crit" }]);
    await expect(
      withTenant(db, other.id, (tx) =>
        tx.insertInto("fix_prs").values({ account_id: mine.account_id, repository_id: repositoryId, advisory_id: "x", branch: "shapi/x", state: "open", updated_at: new Date() }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("ignores PR events for branches SHAPI does not own", async () => {
    const t = setup();
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { number: 9, html_url: "x", merged: false, head: { ref: "feature/x", sha: "s" }, labels: [] } })).toBe("ignored: not a SHAPI branch");
    expect(await webhook(t, "pull_request", { action: "closed", pull_request: { number: 9, html_url: "x", merged: false, head: { ref: "shapi/unknown", sha: "s" }, labels: [] } })).toBe("ignored: not a PR SHAPI opened");
  });
});
