import { Command, CommanderError, Option } from "commander";
import { fix, type FixDeps, type FixOptions } from "./fix";
import { APP_URL, renderText, title } from "./report";
import { VERSION, preparePython, scan, toJsonReport, type ScanOptions } from "./scan";

export { DEFAULT_ADVISORIES, VERSION, preparePython, scan, toJsonReport, type ScanOptions, type ScanOutcome } from "./scan";
export { DEFAULT_RECORDINGS, fix, type FixDeps, type FixOptions, type FixOutcome } from "./fix";
export { renderText } from "./report";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Whether stdout is a color-capable terminal. */
  isTTY?: boolean;
}

const processIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTTY: process.stdout.isTTY,
};

/** Run the CLI with `argv` (as in process.argv) and return the exit code. */
export async function run(argv: string[], io: Io = processIo, fixDeps: Partial<FixDeps> = {}): Promise<number> {
  let exitCode = 0;
  await preparePython();
  const program = new Command()
    .name("shapi")
    .description("Map the third-party APIs a codebase depends on and flag the breaking changes that hit it.")
    .version(VERSION)
    .addHelpText("beforeAll", `${title(Boolean(io.isTTY))}\n`)
    .addHelpText("afterAll", `\nRun it without installing: npx shapi-cli scan .\nFix PRs and a dashboard on every push: install the GitHub App at ${APP_URL}\n`)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("scan")
    .description("Scan a repository and report affected call sites")
    .argument("[path]", "directory to scan", ".")
    .option("--json", "print a JSON report (includes the api.lock)")
    .option("--out <file>", "write the api.lock to this file")
    .option("--sbom <file>", "also write the api.lock as a CycloneDX 1.7 SaaSBOM")
    .option("--vex <file>", "also write the verdicts as an OpenVEX 0.2.0 document")
    .option("--repo <url>", "clone a git repository (shallow) into a temp dir and scan it")
    .option("--advisories <dir>", "advisory directory (default: the bundled advisories/)")
    .option("--fail-on <severity>", "exit 1 when an affected call site is at least this severe (critical|high|medium|low|none)", "critical")
    .option("--no-color", "disable color")
    .addOption(new Option("--now <date>", "evaluate deadlines as of this date").hideHelp())
    .action((target: string, opts: ScanOptions) => {
      const outcome = scan(opts.repo ? undefined : target, opts);
      if (opts.json) io.stdout(JSON.stringify(toJsonReport(outcome), null, 2) + "\n");
      else io.stdout(renderText(outcome, opts.color !== false && Boolean(io.isTTY)));
      exitCode = outcome.exitCode;
    });

  program
    .command("fix")
    .description("Repair affected call sites test-first: generate a contract test, apply the recipe (or Claude), keep the change only if the test passes")
    .argument("[path]", "repository to fix", ".")
    .option("--repo <url>", "clone a GitHub repository (shallow) and fix it; with --pr the PR goes to that repository")
    .option("--advisory <id>", "only this advisory")
    .option("--advisories <dir>", "advisory directory (default: the bundled advisories/)")
    .option("--db <file>", "shape store with canary observations (checked before recordings)", ".shapi/shapes.db")
    .option("--recordings <dir>", "recorded response sequences (default: the bundled fixtures/recordings/)")
    .option("--llm", "ask Claude when no recipe fixes the call site (needs ANTHROPIC_API_KEY)")
    .option("--write", "write the fix and the contract test into the local repository")
    .option("--pr", "open a pull request with the fix and the contract test")
    .addOption(new Option("--now <date>", "evaluate deadlines as of this date").hideHelp())
    .action(async (target: string, opts: FixOptions) => {
      io.stdout(`${title(Boolean(io.isTTY))}\n`);
      const outcomes = await fix(opts.repo ? undefined : target, opts, { log: (l) => io.stdout(`${l}\n`), ...fixDeps });
      if (outcomes.some((o) => o.result?.status === "fixed") && !opts.write && !opts.pr) io.stdout("\nNothing was changed. Add --write to keep these fixes, or --pr to open pull requests.\n");
      io.stdout(`Fix PRs and a dashboard on every push: install the GitHub App at ${APP_URL}\n`);
      exitCode = outcomes.every((o) => o.result?.status === "fixed" || o.result?.status === "already-handled") ? 0 : 1;
    });

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    io.stderr(`shapi: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export async function main(argv: string[]): Promise<number> {
  return run(argv);
}
