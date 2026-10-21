import { Command, CommanderError } from "commander";
import { ShapeStore } from "@shapi/shapes";
import { DEFAULT_DB, DEV_SECRET, runEvery, runOnce, type RunReport } from "./scheduler";

export type { Env, Probe, Worker } from "./probe";
export { githubWorker } from "./workers/github";
export { stripeWorker } from "./workers/stripe";
export { DEFAULT_DB, DEV_SECRET, WORKERS, runEvery, runOnce, type ProbeResult, type RunOptions, type RunReport } from "./scheduler";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const processIo: Io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) };

export function renderReport(report: RunReport): string {
  const lines: string[] = [];
  const idWidth = Math.max(0, ...report.results.map((r) => r.id.length));
  for (const r of report.results) {
    const outcome = r.error ? `error: ${r.error}` : `${r.status}  ${r.changed ? "CHANGED" : r.previousHash ? "same" : "first"}  ${r.shapeHash!.slice(0, 12)}`;
    lines.push(`  ${r.id.padEnd(idWidth)}  ${r.method.padEnd(4)} ${r.endpoint}  ${outcome}  ${r.ms} ms`);
  }
  for (const s of report.skipped) lines.push(`  ${s.id.padEnd(idWidth)}  skipped: ${s.reason}`);
  const changed = report.results.filter((r) => r.changed).length;
  const failed = report.results.filter((r) => r.error).length;
  lines.push(`${report.results.length} probes, ${changed} changed, ${failed} failed, ${report.skipped.length} skipped`);
  return lines.join("\n") + "\n";
}

/** `shapi-canary run [--once] [--interval <minutes>] [--db <file>] [--provider <id...>]` and `shapi-canary status`. */
export async function run(argv: string[], io: Io = processIo, env = process.env): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name("shapi-canary")
    .description("Probe provider APIs on a schedule and record response shapes")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("run")
    .description("run the canary probes")
    .option("--once", "run every probe once and exit")
    .option("--interval <minutes>", "minutes between runs when not --once", "60")
    .option("--db <file>", "shape store file", DEFAULT_DB)
    .option("--provider <id...>", "only these providers")
    .action(async (opts: { once?: boolean; interval: string; db: string; provider?: string[] }) => {
      if (!env.SHAPI_SHAPE_SECRET) io.stderr(`shapi-canary: SHAPI_SHAPE_SECRET not set, using the dev secret "${DEV_SECRET}"\n`);
      const store = ShapeStore.open(opts.db);
      const runOpts = { store, env, providers: opts.provider };
      if (opts.once) {
        const report = await runOnce(runOpts);
        io.stdout(renderReport(report));
        store.close();
        exitCode = report.results.some((r) => r.error) ? 1 : 0;
        return;
      }
      const minutes = Number(opts.interval);
      if (!(minutes > 0)) throw new Error(`--interval: expected a positive number of minutes, got ${opts.interval}`);
      io.stdout(`running every ${minutes} min; Ctrl+C to stop\n`);
      await new Promise<void>((resolve) => {
        const stop = runEvery(minutes * 60_000, runOpts, (report) => io.stdout(`${new Date().toISOString()}\n${renderReport(report)}`));
        process.once("SIGINT", () => {
          stop();
          store.close();
          resolve();
        });
      });
    });

  program
    .command("status")
    .description("list observed endpoints in the shape store")
    .option("--db <file>", "shape store file", DEFAULT_DB)
    .action((opts: { db: string }) => {
      const store = ShapeStore.open(opts.db);
      const rows = store.endpoints();
      store.close();
      if (rows.length === 0) io.stdout("no observations yet\n");
      for (const r of rows) {
        io.stdout(`  ${r.provider}  ${r.method} ${r.endpoint}  ${r.observations} observations, ${r.distinctShapes} distinct shapes, last ${r.lastObservedAt}\n`);
      }
    });

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    io.stderr(`shapi-canary: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}
