import { describe, expect, it } from "vitest";
import { checkSuite, failingTests, suiteCommand, suiteCounts, testTotal, type SuiteRun } from "@shapi/repair";

const run = (passed: boolean, output: string): SuiteRun => ({ passed, exitCode: passed ? 0 : 1, output, command: "npm test" });
const vitestPass = " ✓ src/a.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n";
const vitestFail = (name: string) => ` × ${name} 3ms\n\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n`;

describe("suiteCommand", () => {
  const scripts = (test: unknown) => JSON.stringify({ scripts: { test } });
  it("runs the test script with the repository's package manager", () => {
    expect(suiteCommand(scripts("vitest run"), { pnpm: true, yarn: false })).toEqual(["corepack", ["pnpm", "test"]]);
    expect(suiteCommand(scripts("jest"), { pnpm: false, yarn: true })).toEqual(["corepack", ["yarn", "test"]]);
    expect(suiteCommand(scripts("node --test"), { pnpm: false, yarn: false })).toEqual(["npm", ["test"]]);
  });
  it("skips a missing script, npm's placeholder and an unreadable package.json", () => {
    const none = { pnpm: false, yarn: false };
    expect(suiteCommand(undefined, none)).toBeUndefined();
    expect(suiteCommand("{", none)).toBeUndefined();
    expect(suiteCommand(JSON.stringify({ scripts: {} }), none)).toBeUndefined();
    expect(suiteCommand(scripts('echo "Error: no test specified" && exit 1'), none)).toBeUndefined();
    expect(suiteCommand(scripts(42), none)).toBeUndefined();
  });
});

describe("suiteCounts and failingTests", () => {
  it("read the summaries of vitest, Jest, Mocha and node:test", () => {
    expect(suiteCounts(vitestFail("a"))).toBe("1 failed | 2 passed");
    expect(suiteCounts("Tests:       1 failed, 4 passed, 5 total\n")).toBe("1 failed, 4 passed, 5 total");
    expect(suiteCounts("  12 passing (40ms)\n  2 failing\n")).toBe("12 passing, 2 failing");
    expect(suiteCounts("# tests 3\n# pass 3\n# fail 0\n")).toBe("3 passed");
    expect(suiteCounts("Error: Cannot find module 'x'\n")).toBeUndefined();
  });
  it("name the failing tests", () => {
    expect([...failingTests(vitestFail("src/a.test.ts > charges > retries"))]).toEqual(["src/a.test.ts > charges > retries"]);
    expect([...failingTests("  ● billing › creates an invoice\n")]).toEqual(["billing › creates an invoice"]);
    expect([...failingTests("not ok 2 - parses the reply\n")]).toEqual(["parses the reply"]);
  });
});

describe("checkSuite", () => {
  const after = (...runs: SuiteRun[]) => {
    let i = 0;
    return async () => runs[Math.min(i++, runs.length - 1)];
  };

  it("passes when the tests pass before and after", async () => {
    expect(await checkSuite(run(true, vitestPass), after(run(true, vitestPass)))).toMatchObject({ status: "passed", before: "3 passed", after: "3 passed", runs: 1 });
  });

  it("fails when a test that passed before fails after, three runs in a row", async () => {
    const r = await checkSuite(run(true, vitestPass), after(run(false, vitestFail("charges > retries"))));
    expect(r).toMatchObject({ status: "failed", runs: 3 });
    expect(r.detail).toBe("tests that passed before the change fail after it: charges > retries");
  });

  it("calls a failure that passes on a rerun flaky, and passes", async () => {
    const r = await checkSuite(run(true, vitestPass), after(run(false, vitestFail("x")), run(true, vitestPass)));
    expect(r).toMatchObject({ status: "passed", runs: 2 });
    expect(r.detail).toMatch(/flaky/);
  });

  it("does not blame the change for tests that already failed", async () => {
    expect(await checkSuite(run(false, vitestFail("old")), after(run(false, vitestFail("old"))))).toMatchObject({ status: "passed", runs: 1 });
    const r = await checkSuite(run(false, vitestFail("old")), after(run(false, `${vitestFail("old")}${vitestFail("new")}`)));
    expect(r).toMatchObject({ status: "failed" });
    expect(r.detail).toBe("new failing tests after the change: new");
  });

  it("is not run without a test command, or when the tests never ran", async () => {
    expect(await checkSuite(undefined, after(run(true, vitestPass)))).toMatchObject({ status: "not-run" });
    expect((await checkSuite(run(false, "Error: Cannot find module 'jest'\n"), after(run(true, vitestPass)))).detail).toBe(
      "the tests did not run before the change: Error: Cannot find module 'jest'",
    );
    expect(await checkSuite(run(false, " Tests  1 failed (1)\n"), after(run(false, ""))).then((r) => r.status)).toBe("not-run");
  });
});

describe("V-02: a fix may not remove or skip tests", () => {
  it("counts how many tests ran", () => {
    expect(testTotal("1 failed | 2 passed")).toBe(3);
    expect(testTotal("1 failed, 4 passed, 5 total")).toBe(5);
    expect(testTotal("12 passing, 2 failing")).toBe(14);
    expect(testTotal("3 passed")).toBe(3);
    expect(testTotal(undefined)).toBeUndefined();
  });

  it("fails a change after which fewer tests run, even when they all pass", async () => {
    const fewer = run(true, " Test Files  1 passed (1)\n      Tests  2 passed (2)\n");
    const r = await checkSuite(run(true, vitestPass), async () => fewer);
    expect(r).toMatchObject({ status: "failed", detail: "fewer tests ran after the change (3 before, 2 after)" });
  });
});
