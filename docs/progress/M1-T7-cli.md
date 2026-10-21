# M1-T7 CLI

What exists: `packages/cli` (npm name `shapi`, bin `shapi`). `shapi scan [path]` extracts call sites, builds the api.lock, loads `advisories/`, runs the matcher, and prints providers, affected call sites (severity, file:line, method and endpoint, advisory, why, fix), exposed call sites, deadlines in the next 90 days, and unresolved count. Flags: `--json` (report with findings plus the full api.lock), `--out <file>` (write api.lock), `--repo <git url>` (shallow clone to a temp dir, scan, delete), `--advisories <dir>`, `--fail-on <critical|high|medium|low|none>` (default critical: exit 1 when a finding is at least that severe; usage errors exit 2), `--no-color`.
How to run: `pnpm install` (builds every package via `prepare`), then `npx shapi scan <dir>`. The root devDependency `shapi: workspace:*` is what puts the bin on `npx`'s path.
Not done: the demo fixture and end-to-end test (T1.8); publishing to npm (the advisories directory is read from the repo, not bundled).
Decisions: `run(argv, io)` is exported so tests drive the CLI in-process; color only on a TTY via `node:util` `styleText` (no extra dependency); `--now` is a hidden flag that pins the date for deterministic deadline tests.

```
npx shapi scan packages/cli/test/fixtures/app
```
