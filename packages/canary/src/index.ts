import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { ShapeStore } from "@shapi/shapes";
import { draftAdvisory, writeDraft } from "./draft";
import { MODELS_DEV_URL, modelsDevDrafts, type ModelsDevApi } from "./models-dev";
import { loadRecording, replay } from "./replay";
import { DEFAULT_DB, DEV_SECRET, WORKERS, runEvery, runOnce, type RunReport } from "./scheduler";
import { WatchSourceSchema, runWatch } from "./watch";

/** Where machine-drafted advisories go for review (advisories/ itself holds reviewed ones). */
export const DEFAULT_DRAFTS = "advisories/drafts";
/** The provider pages the watcher checks (C-01), and their committed snapshots. */
export const DEFAULT_WATCH_SOURCES = "advisories/watch/sources.json";
export const DEFAULT_WATCH_SNAPSHOTS = "advisories/watch/snapshots";

export { probeSource, type Env, type Probe, type Worker } from "./probe";
export { draftAdvisory, writeDraft, type DraftInput } from "./draft";
export { MAX_SHRINK, WatchSourceSchema, checkSource, pageText, runWatch, type WatchIssue, type WatchOutcome, type WatchResult, type WatchRun, type WatchSource } from "./watch";
export { MODELS_DEV_URL, modelsDevDrafts, modelsDevHost, type ModelsDevApi, type ModelsDevDraft } from "./models-dev";
export { githubWorker } from "./workers/github";
export { stripeWorker } from "./workers/stripe";
export { anthropicWorker, hubspotWorker, openaiWorker, slackWorker, twilioWorker } from "./workers/more";
export { RecordingSchema, fixtureStatus, loadRecording, replay, type FixtureState, type FixtureStatus, type Recording, type ReplayResult } from "./replay";
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
    for (const c of r.diff?.changes ?? []) lines.push(`      ${c.impact.padEnd(13)} ${c.detail}`);
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
    .option("--drafts <dir>", "write draft advisories for breaking changes here", DEFAULT_DRAFTS)
    .option("--no-drafts", "do not write draft advisories")
    .action(async (opts: { once?: boolean; interval: string; db: string; provider?: string[]; drafts: string | false }) => {
      const unknown = (opts.provider ?? []).filter((p) => !WORKERS.some((w) => w.provider === p));
      if (unknown.length) throw new Error(`--provider: unknown ${unknown.join(", ")} (known: ${WORKERS.map((w) => w.provider).join(", ")})`);
      if (!env.SHAPI_SHAPE_SECRET) io.stderr(`shapi-canary: SHAPI_SHAPE_SECRET not set, using the dev secret "${DEV_SECRET}"\n`);
      const store = ShapeStore.open(opts.db);
      const runOpts = { store, env, providers: opts.provider };
      const saveDrafts = (report: RunReport) => {
        if (opts.drafts === false) return;
        for (const r of report.results) if (r.draft) io.stdout(`draft advisory: ${writeDraft(r.draft, opts.drafts)}\n`);
      };
      if (opts.once) {
        const report = await runOnce(runOpts);
        io.stdout(renderReport(report));
        saveDrafts(report);
        store.close();
        exitCode = report.results.some((r) => r.error) ? 1 : 0;
        return;
      }
      const minutes = Number(opts.interval);
      if (!(minutes > 0)) throw new Error(`--interval: expected a positive number of minutes, got ${opts.interval}`);
      io.stdout(`running every ${minutes} min; Ctrl+C to stop\n`);
      await new Promise<void>((resolve) => {
        const stop = runEvery(
          minutes * 60_000,
          runOpts,
          (report) => {
            io.stdout(`${new Date().toISOString()}\n${renderReport(report)}`);
            saveDrafts(report);
          },
          (err) => io.stderr(`shapi-canary: run failed: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.once("SIGINT", () => {
          // Close the store only after a run in progress has recorded its results.
          void stop().then(() => {
            store.close();
            resolve();
          });
        });
      });
    });

  program
    .command("replay")
    .description("replay a recorded response sequence through the shape store and diff")
    .argument("<recording>", "recording JSON file")
    .option("--db <file>", "shape store file (default: in memory)", ":memory:")
    .option("--drafts <dir>", "write a draft advisory for a breaking change here", DEFAULT_DRAFTS)
    .option("--no-drafts", "do not write a draft advisory")
    .action((file: string, opts: { db: string; drafts: string | false }) => {
      const store = ShapeStore.open(opts.db);
      const result = replay(loadRecording(file), store, env.SHAPI_SHAPE_SECRET ?? DEV_SECRET);
      store.close();
      const { provider, method, endpoint } = result.recording;
      io.stdout(`${provider} ${method} ${endpoint}: ${result.observations.length} observations replayed\n`);
      if (!result.diff) {
        io.stdout("shape never changed\n");
        return;
      }
      io.stdout(`changed between ${result.before!.observedAt} and ${result.after.observedAt}${result.diff.breaking ? " (BREAKING)" : ""}\n`);
      for (const c of result.diff.changes) io.stdout(`  ${c.impact.padEnd(13)} ${c.changeClass ?? "-"}  ${c.detail}\n`);
      const draft = draftAdvisory({ before: result.before!, after: result.after, diff: result.diff });
      if (draft && opts.drafts !== false) io.stdout(`draft advisory: ${writeDraft(draft, opts.drafts)}\n`);
    });

  program
    .command("models-dev")
    .description("draft a version-sunset advisory for every model models.dev marks deprecated on a host SHAPI knows")
    .option("--source <url|file>", "models.dev api.json, as a URL or a file", MODELS_DEV_URL)
    .option("--drafts <dir>", "where to write the drafts", DEFAULT_DRAFTS)
    .action(async (opts: { source: string; drafts: string }) => {
      const api = (
        /^https?:\/\//.test(opts.source) ? await (await fetch(opts.source, { headers: { "user-agent": "shapi-canary" } })).json() : JSON.parse(readFileSync(opts.source, "utf8"))
      ) as ModelsDevApi;
      const today = new Date().toISOString().slice(0, 10);
      let added = 0;
      for (const { advisory } of modelsDevDrafts(api, { today })) {
        // A draft written on an earlier run keeps the day the model was first seen deprecated.
        const file = path.join(opts.drafts, `${advisory.id}.json`);
        const earlier = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { firstObserved?: string; effectiveDate?: string }) : undefined;
        if (earlier?.firstObserved) Object.assign(advisory, { firstObserved: earlier.firstObserved, effectiveDate: earlier.effectiveDate ?? earlier.firstObserved });
        else added++;
        writeDraft(advisory, opts.drafts);
        io.stdout(`${earlier ? "kept " : "new  "} ${advisory.id}\n`);
      }
      io.stdout(`${added} new drafts in ${opts.drafts}\n`);
    });

  program
    .command("watch")
    .description("fetch the watched provider pages through the fetch guards and compare each with its snapshot")
    .option("--sources <file>", "watch sources", DEFAULT_WATCH_SOURCES)
    .option("--snapshots <dir>", "committed snapshots", DEFAULT_WATCH_SNAPSHOTS)
    .option("--drafts <dir>", "where drafts for changed pages go", `${DEFAULT_DRAFTS}/watch`)
    .option("--issues <file>", "write the issues (one per failing source) here as JSON")
    .action(async (opts: { sources: string; snapshots: string; drafts: string; issues?: string }) => {
      const sources = WatchSourceSchema.array().parse(JSON.parse(readFileSync(opts.sources, "utf8")));
      const run = await runWatch(sources, { snapshots: opts.snapshots, drafts: opts.drafts });
      for (const r of run.results) io.stdout(`${r.outcome.padEnd(9)} ${r.id}${r.reason ? `: ${r.reason}` : ""}${r.added ? `  (+${r.added.length} −${r.removed?.length ?? 0} lines)` : ""}\n`);
      for (const d of run.drafts) io.stdout(`draft: ${d}\n`);
      if (opts.issues) writeFileSync(opts.issues, `${JSON.stringify(run.issues, null, 2)}\n`);
      io.stdout(`${run.results.length} pages, ${run.drafts.length} changed, ${run.issues.length} failed\n`);
      // A failing source should fail a scheduled run, so someone looks.
      if (run.issues.length) exitCode = 1;
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
        io.stdout(`  ${r.source}  ${r.method} ${r.endpoint}  ${r.observations} observations, ${r.distinctShapes} distinct shapes, last ${r.lastObservedAt}\n`);
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
