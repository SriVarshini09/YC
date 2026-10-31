import { runFailure, testCounts, type TestRun } from "./runner";

/** One run of the repository's own test command. */
export interface SuiteRun extends TestRun {
  /** The command, for example "npm test". */
  command: string;
}

/**
 * Whether the repository's own tests still pass after a fix (execution plan V-01). A fix that makes a
 * test fail that passed before it is not kept; a test that fails once and passes on a rerun is flaky.
 */
export interface SuiteCheck {
  status: "passed" | "failed" | "not-run";
  command?: string;
  /** The runner's counts before and after the change, for example "12 passed". */
  before?: string;
  after?: string;
  /** Why it was not run, what newly fails, or a note such as a flaky rerun. */
  detail: string;
  /** Runs of the test command after the change: more than 1 means it was rerun. */
  runs?: number;
}

/** How many times the test command runs after a change before a new failure counts. */
export const SUITE_ATTEMPTS = 3;

/** The default `npm init` script, which only prints an error. */
const PLACEHOLDER = /no test specified/;

/**
 * The repository's own test command: its package manager running the `test` script of the root
 * package.json. Undefined when it has none, or only npm's placeholder.
 */
export function suiteCommand(packageJson: string | undefined, lockfiles: { pnpm: boolean; yarn: boolean }): [string, string[]] | undefined {
  if (packageJson === undefined) return undefined;
  let script: unknown;
  try {
    script = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts?.test;
  } catch {
    return undefined;
  }
  if (typeof script !== "string" || !script.trim() || PLACEHOLDER.test(script)) return undefined;
  if (lockfiles.pnpm) return ["corepack", ["pnpm", "test"]];
  if (lockfiles.yarn) return ["corepack", ["yarn", "test"]];
  return ["npm", ["test"]];
}

/** Output without ANSI color codes: some runners color it even when asked not to (pytest whenever FORCE_COLOR is set at all). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ANSI, "");

/** The counts of vitest, Jest, Mocha, node:test or pytest, from the last summary the runner printed. */
export function suiteCounts(raw: string): string | undefined {
  const output = plain(raw);
  const vitest = testCounts(output);
  if (vitest) return vitest;
  const jest = [...output.matchAll(/^[ \t]*Tests:[ \t]+((?:\d+ [a-z]+, )*\d+ total)[ \t]*\r?$/gm)].at(-1)?.[1];
  if (jest) return jest;
  const passing = [...output.matchAll(/^[ \t]*(\d+) passing\b/gm)].at(-1)?.[1];
  if (passing !== undefined) {
    const failing = [...output.matchAll(/^[ \t]*(\d+) failing\b/gm)].at(-1)?.[1];
    return `${passing} passing${failing ? `, ${failing} failing` : ""}`;
  }
  const pass = [...output.matchAll(/^# pass (\d+)\r?$/gm)].at(-1)?.[1];
  const fail = [...output.matchAll(/^# fail (\d+)\r?$/gm)].at(-1)?.[1];
  if (pass !== undefined) return `${pass} passed${fail && fail !== "0" ? `, ${fail} failed` : ""}`;
  // pytest: "3 passed, 1 failed, 2 warnings in 0.52s", framed by "=" in the default output. Warnings are not tests.
  const pytest = [...output.matchAll(/^=*[ \t]*((?:\d+ [a-z]+(?:, )?)+) in [\d.]+s\b/gm)].at(-1)?.[1];
  if (pytest) {
    const counts = pytest.split(", ").filter((c) => /^\d+ (passed|failed|errors?|skipped|xfailed|xpassed)$/.test(c));
    if (counts.length) return counts.join(", ");
  }
  return undefined;
}

/**
 * How many tests ran, from a summary suiteCounts returned: Jest's "N total", otherwise the sum of the
 * counts ("1 failed | 2 passed" is 3). Skipped tests count, so skipping one to pass still lowers nothing.
 */
export function testTotal(counts: string | undefined): number | undefined {
  if (!counts) return undefined;
  const total = /(\d+) total/.exec(counts);
  if (total) return Number(total[1]);
  const numbers = [...counts.matchAll(/(\d+) [a-z]+/g)].map((m) => Number(m[1]));
  return numbers.length ? numbers.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * The names of failing tests as the runner prints them: vitest's `×`/`FAIL` lines, Jest's `●` headings,
 * Mocha's numbered failures and node:test's `not ok`. Empty when the runner prints none of these.
 */
export function failingTests(raw: string): Set<string> {
  const output = plain(raw);
  const names = new Set<string>();
  const patterns = [
    /^[ \t]*(?:×|✕|✗)[ \t]+(.+?)(?:[ \t]+\d+ms)?\r?$/gm,
    /^[ \t]*FAIL[ \t]+(.+?)\r?$/gm,
    /^[ \t]*●[ \t]+(.+?)\r?$/gm,
    /^[ \t]*\d+\)[ \t]+(.+?)\r?$/gm,
    /^not ok \d+ - (.+?)\r?$/gm,
    // pytest's short summary (-rfE): "FAILED tests/test_a.py::test_x - AssertionError", "ERROR tests/test_b.py".
    /^(?:FAILED|ERROR) (\S+)/gm,
  ];
  for (const p of patterns) for (const m of output.matchAll(p)) names.add(m[1]!.trim());
  return names;
}

/**
 * Compare the repository's tests before a change with runs after it. `before` is undefined when the
 * repository has no test command; `after` runs the command on the changed code.
 */
export async function checkSuite(before: SuiteRun | undefined, after: () => Promise<SuiteRun | undefined>): Promise<SuiteCheck> {
  if (!before) return { status: "not-run", detail: "the repository has no test command (no test script in package.json)" };
  const beforeCounts = suiteCounts(before.output);
  if (!before.passed && !beforeCounts) {
    return { status: "not-run", command: before.command, detail: `the tests did not run before the change: ${runFailure(before.output)}` };
  }
  const failedBefore = failingTests(before.output);
  if (!before.passed && failedBefore.size === 0) {
    return { status: "not-run", command: before.command, before: beforeCounts, detail: "the tests already failed before the change, and their output names no failing test to compare" };
  }

  let run: SuiteRun | undefined;
  let newFailures: string[] = [];
  let runs = 0;
  for (let i = 0; i < SUITE_ATTEMPTS; i++) {
    run = await after();
    runs++;
    if (!run) return { status: "not-run", command: before.command, before: beforeCounts, detail: "the test command could not run after the change" };
    if (run.passed) break;
    newFailures = [...failingTests(run.output)].filter((n) => !failedBefore.has(n));
    // Tests that failed before and still fail are the repository's own problem, not this change's.
    if (!before.passed && newFailures.length === 0) break;
  }
  const afterCounts = run ? suiteCounts(run.output) : undefined;
  const base = { command: before.command, before: beforeCounts, after: afterCounts, runs };
  // V-02: passing because fewer tests ran is not passing; a fix may not remove or skip tests.
  const ranBefore = testTotal(beforeCounts);
  const ranAfter = testTotal(afterCounts);
  if (ranBefore !== undefined && ranAfter !== undefined && ranAfter < ranBefore) {
    return { ...base, status: "failed", detail: `fewer tests ran after the change (${ranBefore} before, ${ranAfter} after)` };
  }
  if (run!.passed) return { ...base, status: "passed", detail: runs > 1 ? `passed on rerun ${runs} of ${SUITE_ATTEMPTS} (a flaky test)` : "passed" };
  if (!before.passed && newFailures.length === 0) return { ...base, status: "passed", detail: "no new failing test; these already failed before the change" };
  const named = newFailures.length ? `: ${newFailures.slice(0, 5).join("; ")}${newFailures.length > 5 ? `; and ${newFailures.length - 5} more` : ""}` : "";
  return { ...base, status: "failed", detail: `${before.passed ? "tests that passed before the change fail after it" : "new failing tests after the change"}${named}` };
}
