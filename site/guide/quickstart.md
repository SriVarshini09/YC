---
description: "Scan a repository for the code a third-party API change breaks, then fix it test-first. Two commands, no account."
---

# Quickstart

You need **Node.js 22.14 or later** (Node 23 and 25 are not supported).

## 1. Scan a repository

From the root of a TypeScript, JavaScript or Python project:

```sh
npx shapi-cli scan .
```

`scan` parses your code statically. It does not install dependencies, run your code or send it anywhere. The output lists:

- **Providers**: the third-party APIs your code calls (GitHub, Stripe, QuickBooks, HubSpot, Xero, Meta Graph, Slack, OpenAI and more) and how many call sites each has.
- **Affected call sites**: code that depends on exactly what an API changed, with the file and line, the reason, and how to fix it.
- **Possibly affected** (when there are any): calls whose path, HTTP method, host or model is only known at runtime, which an API change may reach. Check these by hand.
- **Exposed, not affected** (when there are any): calls to an endpoint that changed, which don't depend on what changed. Nothing to fix.
- **Could not tell, check these by hand** (when there are any): calls to a known provider whose whole path is built at runtime, so SHAPI can't tell which endpoint they call. They aren't counted as clear.
- **Retired names in the code** (when there are any): model ids, field names and enum values that a verified advisory retires, found anywhere in your code, such as a model id kept in a config constant. A line already listed as affected isn't repeated. The GitHub App's check shows the same list.
- **Deadlines in the next 90 days**: announced changes, such as a version sunset, for the providers this repository uses (through a call site or a declared SDK), with how many call sites each one hits.

For example, against SHAPI's demo service:

```text
Affected call sites (3)
  CRITICAL  src/deploy.ts:13  POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
            workflow_dispatch returns 200 with a body instead of 204  [github-workflow-dispatch-204-to-200]
            why: compares the response status to 204
            fix: Treat both 200 and 204 as success (any 2xx).
```

## 2. Save the dependency map

```sh
npx shapi-cli scan . --out api.lock
```

`api.lock` is a JSON file with one entry per call site: provider, method, endpoint, file and line, and what the code depends on. Commit it to review changes to your API surface in pull requests.

## 3. Fix what can be fixed

```sh
npx shapi-cli fix .
```

`fix` copies your repository to a temporary folder and, for each affected TypeScript or JavaScript call site whose advisory has a fix recipe:

1. writes a contract test that calls your code with the response it was written for and the response the provider sends now
2. runs it and confirms that it **fails**
3. applies the advisory's deterministic recipe
4. runs the test again, and keeps the change only if it **passes**.

Call sites without a recipe (and Python call sites outside the two recipes Python has so far) are reported as not fixed; `shapi scan` shows the provider's migration steps for them.

Nothing in your repository changes until you ask:

```sh
npx shapi-cli fix . --write   # write the fix and the contract test into your working tree
npx shapi-cli fix . --pr      # open a pull request (uses GITHUB_TOKEN, GH_TOKEN or your gh login)
```

`fix` runs the contract test on your machine, against your own code. See [how fixes are verified](/guide/fixes).

## Install it

```sh
npm install -g shapi-cli
shapi scan .
```

## Use it in CI

`scan` exits with code `1` when an affected call site is at least as severe as `--fail-on` (default `critical`), so a CI step fails on a breaking change:

```yaml
- run: npx shapi-cli scan . --fail-on high
```

Next: the [CLI reference](/guide/cli).
