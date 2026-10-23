# GitHub App

::: info Early access
The hosted GitHub App is not open for public installation yet. Everything on this page is built and tested end to end; the CLI works for everyone today.
:::

## What it does

- **On every push to your default branch**, SHAPI downloads that commit with a short-lived token that can only read that one repository. It builds the api.lock and posts a **`SHAPI` check** on the commit: neutral by default, with an annotation on each affected line.
- **For each affected call site with a fix recipe**, it verifies the fix in an isolated sandbox and opens a **pull request** with the fix and its contract test.
- **When an advisory is added or changed**, it re-matches every installed repository's stored api.lock and opens PRs where the new advisory hits.
- **A `SHAPI Dashboard` issue** in each repository lists open fix PRs, fixes waiting for a limit, fixes you closed, changes that need a manual fix, and upcoming deadlines.

## Permissions

| Permission | Why |
|---|---|
| Contents: read and write | Read code to scan it; push fix branches. It cannot change workflow files. |
| Pull requests: read and write | Open and update fix PRs. |
| Checks: read and write | Post the `SHAPI` check on commits. |
| Issues: read and write | The SHAPI Dashboard issue. |
| Metadata: read | Required by GitHub for every app. |

Events: `push`, `pull_request`, `issues`, plus the installation events every app receives.

## Noise controls

- At most **2 new PRs per hour** and **10 open at once** per repository, most urgent first. Both are configurable in the web app.
- **One branch per advisory:** reruns update the same PR instead of opening duplicates.
- **A PR you close without merging stays closed.** Tick "open it again" on the dashboard if you change your mind.
- **The `shapi:stop` label** freezes a PR. Pausing a repository, from the dashboard or the web app, stops all changes.
- **The check is neutral by default** and never blocks a merge, unless you turn on *Fail the SHAPI check*.

## The web app

Sign in with GitHub to see each repository's latest scan, its findings with links to the exact lines, fix PR history and recent scans. That is also where you change the limits, the check behavior and the Claude opt-in, and where you pause a repository. SHAPI keeps no GitHub user token: it reads who you are and which installations you can access, then discards the token.

## Plans

Public repositories and one private repository are free. Each further private repository is a monthly per-repository price; pricing will be announced. Adding private repositories never raises the bill on its own: the web app asks first.
