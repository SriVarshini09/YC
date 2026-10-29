# FAQ

## Which languages does SHAPI support?

TypeScript and JavaScript, with the usual HTTP clients (`fetch`, axios, got, undici, ky, node-fetch) and the official SDKs of the providers it knows.

Python is scanned too: `requests`, `httpx`, `aiohttp`, and the OpenAI, Anthropic, Stripe, Slack, Twilio and HubSpot SDKs. SHAPI finds the affected call sites in Python, but proposes fixes only for TypeScript and JavaScript for now.

## Which APIs does it know?

The call-site map covers GitHub, Stripe, QuickBooks, Xero, HubSpot, Slack, OpenAI, Meta Graph, Reddit and more. The breaking changes it can detect are the ones in the [advisory database](/advisories), which grows as changes are found. You can [contribute](https://github.com/SriVarshini09/shapi-advisories/blob/main/CONTRIBUTING.md) too.

## How is this different from Dependabot or Renovate?

Those update your **dependencies** when a new version is released. SHAPI watches the **behavior of the APIs** your code calls, which can change with no new version anywhere. It tells you which lines depend on what changed, and fixes them with a test that proves it.

## Does `scan` run my code?

No. It parses your files statically. Only `fix` runs code: a generated contract test, on your machine for the CLI, or in an isolated sandbox for the GitHub App. See [security](/security).

## What does "exposed" mean?

The call site calls an endpoint that changed, but does not depend on what changed. For example, it checks `res.ok` while the change was `204` becoming `200`. Exposed call sites are listed, but they are not breaking.

## Will SHAPI flood my repository with pull requests?

No. At most 2 new PRs per hour and 10 open per repository by default, one PR per API change, updated in place, and never reopened once you close it, unless you ask. See [noise controls](/guide/github-app#noise-controls).

## Does SHAPI use AI to change my code?

Not by default. Fixes come from deterministic recipes. Claude is used only when you opt in, and its change is kept only if the contract test passes and the code still type-checks.

## Is it open source?

The `shapi-cli` package is Apache-2.0, and the advisories are CC BY 4.0. The hosted service is not open source.
