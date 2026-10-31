# Submitting a tool to the leaderboard

Any tool that reads code (a linter, a scanner, an LLM agent, a person) can be scored on [APIBreak-Replay](METHODOLOGY.md) and listed in the [leaderboard](LEADERBOARD.md).

## 1. Run your tool

For every scored instance in `datasets/apibreak-v0.json` (`inScope: true`, with a `baseCommit`), run the tool on the repository at two commits, and record whether it flags the code that the advisory (`advisoryId`) describes:

- `baseCommit`, the commit before the human fix: the tool should flag it;
- `fixCommit`, the fix: the tool should not.

Check out the commits however you like, for example `https://codeload.github.com/<repo>/tar.gz/<sha>`. If a repository is gone, every instance is mirrored in Software Heritage (`datasets/apibreak-v0.mirrors.json`). Don't look at the fix commit's diff when judging the base commit.

## 2. Write a results file

Add `packages/bench/submissions/<tool>.json`:

```json
{
  "tool": "your tool",
  "version": "1.2.0",
  "url": "https://example.com/your-tool",
  "submittedBy": "your name or organization",
  "runAt": "2026-11-01T12:00:00Z",
  "dataset": "APIBreak-Replay v0",
  "datasetHash": "37fa931e8278",
  "command": "how to reproduce the run",
  "results": [
    { "id": "github-workflow-dispatch-204-to-200__owner__repo", "base": "flagged", "fix": "clear" }
  ]
}
```

- **The dataset:** `datasetHash` is the first 12 hex characters of the dataset file's SHA-256, as `bench:run` prints it. A new dataset version means a new run.
- **Verdicts:** each of `base` and `fix` is `flagged`, `clear` or `error`. `error` is for when your tool could not run on that commit, and it counts as not flagged at `base` and not clear at `fix`.
- **Coverage:** list every scored instance once, and nothing else.

## 3. Open a pull request

Run `pnpm --filter @shapi/bench bench:leaderboard`. It validates every submission, scores it and rewrites the table in LEADERBOARD.md. Commit both files. CI runs the same check (`bench:leaderboard -- --check`), and a maintainer reruns a sample of your instances before merging.

## The grep baseline

`submissions/grep-baseline.json` is what a regex search finds with no parsing: a `204` in a file that also says `dispatches`, or a `minorversion` below 75. It is written by `bench:baseline-grep` and goes through the same validation and scoring as any other submission, so a tool that can't beat it isn't reading the code.

## Claude Code

`submissions/claude-code.json` is a general coding agent with no SHAPI inside: Claude Code 2.1.316 on `claude-sonnet-5-5` (execution plan P-19). `bench:claude-code` runs it.

- **The question:** Claude Code is given each advisory's public text (provider, title, what changed, endpoint, date, migration note) and asked whether the repository's code breaks because of that change. It must end with `VERDICT: FLAGGED` or `VERDICT: CLEAR`.
- **Isolation:** the base and fix commits are judged separately. Each is a fresh copy without git history, in a throwaway E2B sandbox.
- **Read-only:** Claude Code has Read, Grep and Glob only. It has no shell and no network tools, and nothing from the repository is run.
- **Auditing:** every answer is in `runs/claude-code-<dataset hash>.json`, so any verdict can be checked.

The 28 runs cost about $0.90.
