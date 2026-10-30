---
description: "Every shapi-cli command, option, exit code and environment variable."
---

# CLI reference

Installed as `shapi` (`npm install -g shapi-cli`), or run without installing: `npx shapi-cli <command>`.

## `shapi scan [path]`

Maps the third-party API call sites in a repository (default: the current directory) and matches them against the advisories.

| Option | What it does |
|---|---|
| `--json` | Print a JSON report, including the full api.lock. |
| `--out <file>` | Write the api.lock to this file. |
| `--sbom <file>` | Also write the api.lock as a [CycloneDX 1.7](https://cyclonedx.org/) SaaSBOM: each provider is a service with its endpoints, and each call site is evidence on the client it goes through. The GitHub App serves the same file for each repository from its page in the dashboard. |
| `--vex <file>` | Also write the verdicts as an [OpenVEX 0.2.0](https://github.com/openvex/spec) document: one statement per advisory that reaches the code, `affected` (with the migration note), `not_affected` (the code calls the endpoint but doesn't depend on what changed) or `under_investigation` (possibly affected, or SHAPI could not tell). Each call site is linked on GitHub. Every advisory is also published as an [OSV](https://ossf.github.io/osv-schema/) record at `https://shapi.dev/osv/<id>.json`. |
| `--repo <url>` | Shallow-clone a git repository into a temporary folder and scan it. |
| `--advisories <dir>` | Use this advisory folder instead of the bundled one. |
| `--fail-on <severity>` | Exit `1` when an affected call site is at least this severe: `critical`, `high`, `medium`, `low` or `none`. Default: `critical`. |
| `--no-color` | Plain output. |

Exit codes: `0` nothing at or above `--fail-on`, `1` an affected call site at or above `--fail-on` (or an unknown option), `2` an error such as an unreadable path.

## `shapi fix [path]`

Repairs affected call sites test-first. Without `--write` or `--pr` it only reports.

| Option | What it does |
|---|---|
| `--advisory <id>` | Only this advisory. An unknown id is an error (exit `2`). |
| `--write` | Write the fix and its contract test into the repository. Not with `--repo`: the clone is temporary. |
| `--pr` | Open a pull request with the fix and the contract test. Uses `GITHUB_TOKEN`, `GH_TOKEN` or your `gh` login. From a local checkout, a changed file must match the one on GitHub's default branch (pull first), so the PR never reverts newer commits or publishes local edits. |
| `--repo <url>` | Shallow-clone a GitHub repository and fix it; with `--pr` the PR goes to that repository. |
| `--llm` | When no recipe fixes a call site, ask Claude (needs `ANTHROPIC_API_KEY`). The change is still kept only if the contract test passes and the code still type-checks. At most 20 calls per run (`SHAPI_LLM_CALLS_PER_JOB`). |
| `--advisories <dir>` | Use this advisory folder. |
| `--recordings <dir>` | Recorded before/after responses (default: the bundled recordings). |
| `--db <file>` | A shape store with canary observations, checked before the recordings. Default: `.shapi/shapes.db`. |

Exit codes: `0` every affected call site was fixed or already handles the new response, `1` at least one could not be fixed (or an unknown option), `2` an error.

## Environment

| Variable | Used for |
|---|---|
| `GITHUB_TOKEN`, `GH_TOKEN` | `fix --pr` (otherwise your `gh` login). |
| `ANTHROPIC_API_KEY` | `fix --llm`. |
