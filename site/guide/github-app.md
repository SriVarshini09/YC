---
description: "What the SHAPI GitHub App does on each push, the permissions it asks for, its pull request limits, and plans."
---

# GitHub App

::: info Early access
Anyone can [install the GitHub App](https://github.com/apps/shapi-by-srivarshini/installations/new). It's free during early access, and SHAPI asks before anything is charged. Tell us what breaks: [open an issue](https://github.com/SriVarshini09/shapi-advisories/issues) or email [sri@shapi.dev](mailto:sri@shapi.dev).
:::

## What it does

- **On every push to your default branch**, SHAPI downloads that commit with a short-lived token that can only read that one repository. It builds the api.lock and posts a **`SHAPI` check** on the commit: neutral by default, with an annotation on each affected line. A push that GitHub delivers late, after a newer one (for example after an outage), is not scanned: the newer push's commit is the branch as it is now.
- **For each affected call site with a fix recipe**, it verifies the fix in an isolated sandbox and opens a **pull request** with the fix and its contract test.
- **When an advisory is added or changed**, it re-matches every installed repository's stored api.lock and opens PRs where the new advisory hits.
- **A `SHAPI Dashboard` issue** in each repository lists open fix PRs (grouped by when their change takes effect: already in effect, in the next 30 days, later), fixes waiting for a limit, fixes whose branch you pushed to (SHAPI never overwrites it; delete the branch to let it open the fix), fixes you closed, changes that need a manual fix, and upcoming deadlines.

## Permissions

| Permission | Why |
|---|---|
| Contents: read and write | Read code to scan it; push fix branches. It cannot change workflow files. |
| Pull requests: read and write | Open and update fix PRs. |
| Checks: read and write | Post the `SHAPI` check on commits. |
| Issues: read and write | The SHAPI Dashboard issue. |
| Metadata: read | Required by GitHub for every app. |

Events: `push`, `pull_request`, `issues`, `repository` (SHAPI stops on an archived repository and scans it again once it is unarchived), plus the installation events every app receives.

## Slack alerts

Paste a Slack [incoming webhook](https://api.slack.com/messaging/webhooks) link under **Settings** in the web app, and SHAPI posts to that channel when a repository gets a **new** affected call site. That happens after a push, or when a new advisory hits code SHAPI already mapped. Each message lists the advisories with their severity, links to the exact lines, and the deadlines. A call site that was already affected isn't announced again. Use **Send a test message** to check the link.

## What a fix PR shows

- **The top:**
  - a lead line with the change and its deadline;
  - a table of each call site's line before and after the fix, and where it is;
  - the size of the change and how much to trust it.
- **One line with the five checks:**
  - the contract test (fails before the fix, passes after);
  - your own tests;
  - the undo check: undoing each part of the fix must make its test fail;
  - the scope check: every edit is inside the function that makes the call;
  - the type check.
- **Collapsible sections:**
  - what the provider announced;
  - every affected call site;
  - the checks in detail;
  - the evidence;
  - the call sites SHAPI looked at and left alone, with why.
- **A PR labelled `needs-human`** has a part its test doesn't cover. When a Claude fix also edits code outside the function that makes the call, the PR opens as a draft. Read those parts before merging.
- **👍/👎 links** ask whether the PR was useful. SHAPI stores the answer with the repository and the advisory, never who sent it.

A fix PR can also carry signed attestations of its test result and of the fix itself, made in your own Actions run and checked with `gh attestation verify`: see [Signed attestations](./attestations).

## Noise controls

- At most **2 new PRs per hour** and **10 open at once** per repository, most urgent first. Both are configurable in the web app.
- **One PR per advisory:** it fixes every affected call site in the repository, with a contract test for each, and reruns update the same PR instead of opening duplicates. A call site SHAPI can't fix is listed in the PR and on the dashboard.
- **A PR you close without merging stays closed.** Tick "open it again" on the dashboard if you change your mind.
- **The `shapi:stop` label** freezes a PR. Pausing a repository, from the dashboard or the web app, stops all changes.
- **Three closed in a row pauses it.** When the last three SHAPI PRs in a repository were closed without merging, SHAPI pauses itself there, ticks the pause box on the dashboard and says why. Untick it to resume; only PRs closed after that count toward the next pause.
- **The check is neutral by default** and never blocks a merge, unless you turn on *Fail the SHAPI check*.

## The web app

Sign in with GitHub to see each repository's latest scan, its findings with links to the exact lines, fix PR history and recent scans. That is also where you change the limits, the check behavior and the Claude opt-in, and where you pause a repository. You see only the repositories you can open on GitHub. Pausing one needs write access to it, and the account's settings and billing need an account admin: the owner of a personal account, or for an organization someone who is admin on every repository SHAPI covers there. SHAPI keeps no GitHub user token: it reads who you are, which installations you can access and your permission on each of their repositories, then discards the token. So that access is what GitHub said when you signed in: a repository added to the installation afterwards appears when you sign in again (the web app tells account admins), and until then it doesn't count against an admin.

## Plans

Public repositories are free. Private ones are billed per active committer: anyone who committed to one of them in the last 90 days, counted once however many repositories they commit to. Bots don't count, and the first 3 committers are free. Each further one has a monthly fee, shown in the web app before you pay, and it's free during early access. SHAPI counts committers when it scans a private repository and keeps only a salted hash of each one, never the name or email. New committers never raise the bill on their own: the web app asks first, and the plan goes down by itself when people stop committing.
