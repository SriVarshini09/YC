<p align="center"><a href="https://srivarshini09.github.io/YC/"><img src="https://raw.githubusercontent.com/SriVarshini09/YC/main/brand/png/shapi-lockup-horizontal-light-on-bg-1024.png" alt="SHAPI" width="320"></a></p>

# shapi-cli

**Find the code that breaks when a third-party API changes, and fix it test-first.**

Third-party APIs change behaviour without a new version: GitHub's `workflow_dispatch` started answering `200` instead of `204`, QuickBooks stopped honouring old minor versions, HubSpot retired its v1 pipelines. Code that depended on the old behaviour breaks quietly. `shapi` maps every third-party API call in your repository, checks each one against an advisory database of real API changes, and repairs the ones it can, keeping a change only if a generated contract test fails before it and passes after it.

## Quick start

```sh
npx shapi-cli scan .
```

`scan` reads your code and runs none of it. It prints the affected call sites, the API change behind each, and the deadline if there is one. Add `--out api.lock` to save the dependency map, or `--json` for machine-readable output.

```sh
npx shapi-cli fix .           # repair in a temporary copy and show the fix and its contract test
npx shapi-cli fix . --write   # write the fix and the test into your working tree
npx shapi-cli fix . --pr      # open a pull request (uses GITHUB_TOKEN or your gh login)
```

Install it to get the `shapi` command:

```sh
npm install -g shapi-cli
shapi scan path/to/repo
```

## What it checks

- **Languages:** TypeScript and JavaScript (`fetch`, axios, got, undici, ky, node-fetch, and the official SDKs of the providers it knows), and Python (`requests`, `httpx`, `aiohttp`, and the OpenAI, Anthropic, Stripe, Slack, Twilio and HubSpot SDKs). Fixes are for TypeScript and JavaScript; Python is scanned.
- **Providers:** GitHub, Stripe, QuickBooks, Xero, HubSpot, Slack, OpenAI, Meta Graph and more.
- **Advisories:** reviewed, open JSON advisories ship inside this package. Each one names the endpoint, what changed, when, and the evidence.

## How fixes are verified

For every affected call site, `fix` generates a contract test that calls your code with the response it was written for and the response the provider sends now. The test must fail first. SHAPI then applies a deterministic recipe; with `--llm` and an `ANTHROPIC_API_KEY` it falls back to Claude. The change is kept only if the test then passes. Your repository is never modified unless you pass `--write` or `--pr`.

## Requirements

Node.js 22 or later.

## More

- Documentation: https://srivarshini09.github.io/YC/
- The GitHub App watches your repositories, posts a check on each push, and opens verified fix pull requests: https://github.com/SriVarshini09/YC
- Report a problem: https://github.com/SriVarshini09/YC/issues

## License

Apache-2.0. The advisories in `advisories/` are also published, under CC BY 4.0, at https://github.com/SriVarshini09/shapi-advisories.
