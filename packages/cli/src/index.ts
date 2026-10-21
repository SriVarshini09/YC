import { Command, CommanderError, Option } from "commander";
import { renderText } from "./report";
import { VERSION, scan, toJsonReport, type ScanOptions } from "./scan";

export { DEFAULT_ADVISORIES, VERSION, scan, toJsonReport, type ScanOptions, type ScanOutcome } from "./scan";
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
export async function run(argv: string[], io: Io = processIo): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name("shapi")
    .description("Map the third-party APIs a codebase depends on and flag the breaking changes that hit it.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("scan")
    .description("Scan a repository and report affected call sites")
    .argument("[path]", "directory to scan", ".")
    .option("--json", "print a JSON report (includes the api.lock)")
    .option("--out <file>", "write the api.lock to this file")
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
