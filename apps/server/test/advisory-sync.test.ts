import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, listAdvisories, migrateToLatest, type Db } from "@shapi/db";
import { fakeRepoGitHub } from "../../../test-utils/fake-github";
import { startTestPostgres, type TestPostgres } from "../../../test-utils/postgres";
import { loadConfig, syncAdvisoriesFromGitHub } from "../src/index";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bundled = readdirSync(path.join(root, "advisories")).filter((f) => f.endsWith(".json")).length;
let pg: TestPostgres;
let db: Db;

beforeAll(async () => {
  pg = await startTestPostgres("shapi_advsync");
  const owner = createDb({ connectionString: pg.url, appRole: false });
  await migrateToLatest(owner);
  await owner.destroy();
  db = createDb({ connectionString: pg.url });
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);

/** The public advisory repository as GitHub serves it: advisories/, schema/, scripts/ and docs. */
function advisoryRepo(extra: Record<string, string> = {}) {
  const files: Record<string, string> = { "README.md": "# SHAPI advisories", "schema/advisory.schema.json": "{}", "scripts/validate.mjs": "" };
  for (const f of readdirSync(path.join(root, "advisories")).filter((f) => f.endsWith(".json"))) files[`advisories/${f}`] = readFileSync(path.join(root, "advisories", f), "utf8");
  return fakeRepoGitHub("SriVarshini09/shapi-advisories", { ...files, ...extra });
}

describe("advisory sync from the public repository", () => {
  it("syncs every advisory in advisories/, unauthenticated, and only rewrites what changed", async () => {
    const gh = advisoryRepo();
    const first = await syncAdvisoriesFromGitHub(db, "SriVarshini09/shapi-advisories", { fetch: gh.fetch });
    expect(first).toEqual({ written: bundled, advisories: bundled, invalid: [] });
    expect((await listAdvisories(db)).map((a) => a.id)).toContain("github-workflow-dispatch-204-to-200");
    expect(gh.github.calls.some((c) => c.path === "/repos/SriVarshini09/shapi-advisories/tarball/main")).toBe(true);
    expect(gh.github.calls.some((c) => c.path.endsWith("/access_tokens"))).toBe(false);
    const row = await db.selectFrom("advisories").select("source").where("id", "=", "github-workflow-dispatch-204-to-200").executeTakeFirstOrThrow();
    expect(row.source).toBe("github:SriVarshini09/shapi-advisories");

    expect((await syncAdvisoriesFromGitHub(db, "SriVarshini09/shapi-advisories", { fetch: gh.fetch })).written).toBe(0);
  });

  it("skips and reports a bad file without blocking the rest, and ignores drafts/ and pending/", async () => {
    const gh = advisoryRepo({ "advisories/broken.json": '{"id": "broken"}', "advisories/not-json.json": "{oops", "advisories/drafts/x.json": "{}", "advisories/pending/y.json": "{}" });
    const result = await syncAdvisoriesFromGitHub(db, "SriVarshini09/shapi-advisories", { fetch: gh.fetch });
    expect(result.advisories).toBe(bundled);
    expect(result.invalid.map((i) => i.file)).toEqual(["advisories/broken.json", "advisories/not-json.json"]);
  });

  it("fails loudly when the repository has no valid advisories, keeping what is stored", async () => {
    const before = (await listAdvisories(db)).length;
    const gh = fakeRepoGitHub("SriVarshini09/shapi-advisories", { "README.md": "empty" });
    await expect(syncAdvisoriesFromGitHub(db, "SriVarshini09/shapi-advisories", { fetch: gh.fetch })).rejects.toThrow(/no valid advisories/);
    expect((await listAdvisories(db)).length).toBe(before);
  });

  it("config accepts owner/name only", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x", SHAPI_ADVISORIES_REPO: "SriVarshini09/shapi-advisories" }).SHAPI_ADVISORIES_REPO).toBe("SriVarshini09/shapi-advisories");
    expect(() => loadConfig({ DATABASE_URL: "postgres://x", SHAPI_ADVISORIES_REPO: "https://github.com/x/y" })).toThrow(/owner\/name/);
  });
});
