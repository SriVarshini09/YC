/**
 * Claude Code as an outside tool on the leaderboard (execution plan P-19): a general coding agent with no SHAPI
 * inside, asked from each advisory's public text whether the code breaks.
 *
 * One throwaway E2B sandbox per instance. The base commit and the fix commit are judged separately, each in a fresh
 * copy without git history (a codeload tarball), so the fix can't be seen from the base. Claude Code gets Read, Grep
 * and Glob only: no shell and no network tools, and nothing from the repository is run. The gateway key reaches only
 * the claude process, in a sandbox that is killed afterwards. Runs are kept in --runs, so an interrupted run resumes;
 * the submission is written from them.
 *
 *   E2B_API_KEY=… AI_GATEWAY_API_KEY=… pnpm --filter @shapi/bench bench:claude-code -- --runs <file> [--limit n]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CommandExitError, Sandbox, type CommandResult } from "e2b";
import { scoredIds, type Dataset, type Submission, type SubmissionVerdict as Verdict } from "@shapi/bench";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const root = path.resolve(pkg, "..", "..");
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    runs: { type: "string" },
    limit: { type: "string" },
    dataset: { type: "string", default: path.join(pkg, "datasets", "apibreak-v0.json") },
  },
});
if (!values.runs) throw new Error("--runs <file> is required (the runs so far, kept between attempts)");
const runsFile = values.runs;

const TEMPLATE = "shapi-node22";
const CLAUDE_CODE = "2.1.316";
const MODEL = "claude-sonnet-5-5";
/** No new run starts past this; the cap for a benchmark run is $20. */
const BUDGET_USD = 18;
const PARALLEL = 4;

interface Run {
  verdict: Verdict;
  cost: number;
  turns?: number;
  answer: string;
}

const raw = readFileSync(values.dataset, "utf8");
const dataset = JSON.parse(raw) as Dataset;
const datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
const ids = new Set(scoredIds(dataset));
const scored = dataset.instances.filter((x) => ids.has(x.id));
const runs: Record<string, Run> = existsSync(runsFile) ? (JSON.parse(readFileSync(runsFile, "utf8")) as Record<string, Run>) : {};
const save = () => writeFileSync(runsFile, JSON.stringify(runs, null, 2));
let spent = Object.values(runs).reduce((s, r) => s + r.cost, 0);

/** What a person would give the agent: the provider's change as SHAPI's advisory states it. */
function advisoryText(id: string): string {
  const a = JSON.parse(readFileSync(path.join(root, "advisories", `${id}.json`), "utf8")) as Record<string, unknown> & { endpoint: { method: string; path: string } };
  return [
    `Provider: ${String(a.provider)}`,
    `Title: ${String(a.title)}`,
    `What changed: ${String(a.summary)}`,
    `Endpoint: ${a.endpoint.method} ${a.endpoint.path}`,
    `Takes effect: ${String(a.effectiveDate ?? "already in effect")}`,
    `Migration note: ${String(a.migrationNote)}`,
  ].join("\n");
}

const prompt = (advisory: string) => `You are checking a code repository for one third-party API change. Here is the change, as the provider announced it:

${advisory}

Question: does code in this repository depend on the old behavior, so that it breaks or misbehaves now that this change is in effect? Consider only this change. Search and read the code (you cannot run anything). Code that never calls this API, or that already handles the new behavior, is clear.

End your answer with one last line, exactly "VERDICT: FLAGGED" or "VERDICT: CLEAR".`;

async function sh(vm: Sandbox, cmd: string, opts: { cwd?: string; timeoutMs?: number; envs?: Record<string, string> } = {}): Promise<CommandResult> {
  try {
    return await vm.commands.run(cmd, { timeoutMs: 600_000, ...opts });
  } catch (err) {
    if (err instanceof CommandExitError) return err;
    throw err;
  }
}

/** Claude Code's JSON result: the verdict on its last line, and what the run cost. */
function parse(stdout: string): Run {
  try {
    const j = JSON.parse(stdout) as { result?: string; total_cost_usd?: number; num_turns?: number };
    const answer = String(j.result ?? "");
    const m = /VERDICT:\s*(FLAGGED|CLEAR)/i.exec(answer.trim().split(/\r?\n/).pop() ?? "");
    return { verdict: m ? (m[1]!.toUpperCase() === "FLAGGED" ? "flagged" : "clear") : "error", cost: j.total_cost_usd ?? 0, turns: j.num_turns, answer: answer.slice(-1500) };
  } catch {
    return { verdict: "error", cost: 0, answer: stdout.slice(-500) };
  }
}

async function judge(x: Dataset["instances"][number]): Promise<void> {
  const sides = (
    [
      ["base", x.baseCommit],
      ["fix", x.fixCommit],
    ] as const
  ).filter(([side]) => !runs[`${x.id}:${side}`]);
  if (!sides.length) return;
  const vm = await Sandbox.create(TEMPLATE, { apiKey: process.env.E2B_API_KEY, timeoutMs: 45 * 60_000, allowInternetAccess: true, metadata: { purpose: "p19-claude-code", instance: x.id } });
  try {
    const install = await sh(vm, `npm i --silent --no-audit --no-fund --prefix /home/user/cc @anthropic-ai/claude-code@${CLAUDE_CODE}`);
    if (install.exitCode !== 0) throw new Error(`Claude Code install failed: ${install.stderr.slice(-300)}`);
    for (const [side, sha] of sides) {
      if (spent >= BUDGET_USD) {
        console.log(`budget reached ($${spent.toFixed(2)}); skipping ${x.id}:${side}`);
        continue;
      }
      const dir = `/home/user/w/${side}`;
      const got = await sh(vm, `mkdir -p ${dir} && curl -sfL https://codeload.github.com/${x.repo}/tar.gz/${sha} | tar -xz -C ${dir} --strip-components=1`);
      if (got.exitCode !== 0) {
        runs[`${x.id}:${side}`] = { verdict: "error", cost: 0, answer: `checkout failed: ${got.stderr.slice(-300)}` };
        save();
        continue;
      }
      const r = await sh(
        vm,
        `/home/user/cc/node_modules/.bin/claude -p "$PROMPT" --model ${MODEL} --max-turns 40 --output-format json --allowedTools Read Grep Glob --disallowedTools Bash Edit Write NotebookEdit WebFetch WebSearch Task`,
        {
          cwd: dir,
          timeoutMs: 15 * 60_000,
          envs: { PROMPT: prompt(advisoryText(x.advisoryId!)), CLAUDE_CONFIG_DIR: "/home/user/.cc", ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh", ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY ?? "", ANTHROPIC_API_KEY: "" },
        },
      );
      const result = parse(r.stdout);
      spent += result.cost;
      runs[`${x.id}:${side}`] = result;
      save();
      console.log(`${x.id}:${side} -> ${result.verdict}  $${result.cost.toFixed(3)}  (total $${spent.toFixed(2)})`);
    }
  } finally {
    await vm.kill().catch(() => {});
  }
}

const queue = scored.filter((x) => !runs[`${x.id}:base`] || !runs[`${x.id}:fix`]).slice(0, values.limit ? Number(values.limit) : undefined);
if (queue.length && !(process.env.E2B_API_KEY && process.env.AI_GATEWAY_API_KEY)) throw new Error("E2B_API_KEY and AI_GATEWAY_API_KEY are needed to run");
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    for (let x = queue.shift(); x; x = queue.shift()) await judge(x).catch((err: unknown) => console.log(`${x.id}: ${err instanceof Error ? err.message : String(err)}`));
  }),
);

const complete = scored.every((x) => runs[`${x.id}:base`] && runs[`${x.id}:fix`]);
console.log(`${Object.keys(runs).length} of ${scored.length * 2} runs, $${spent.toFixed(2)}`);
if (!complete) process.exit(1);

const submission: Submission = {
  tool: "Claude Code",
  version: `${CLAUDE_CODE} (${MODEL}, read-only)`,
  url: "https://docs.claude.com/en/docs/claude-code/overview",
  submittedBy: "SHAPI maintainers",
  runAt: new Date().toISOString(),
  dataset: dataset.name,
  datasetHash,
  command: "E2B_API_KEY=… AI_GATEWAY_API_KEY=… pnpm --filter @shapi/bench bench:claude-code -- --runs <file>",
  results: scored.map((x) => ({ id: x.id, base: runs[`${x.id}:base`]!.verdict, fix: runs[`${x.id}:fix`]!.verdict })),
};
writeFileSync(path.join(pkg, "submissions", "claude-code.json"), `${JSON.stringify(submission, null, 2)}\n`);
console.log("wrote submissions/claude-code.json");
