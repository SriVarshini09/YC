# M1-T1 provider registry

What exists: `packages/core` (`@shapi/core`) with `providers.json`, 35 providers (GitHub, Stripe, Twilio, Shopify, QuickBooks, Xero, HubSpot, Slack, OpenAI, Anthropic, Salesforce, Reddit, Meta Graph, X and more), each with hostname patterns, SDK package names, docs and changelog URLs, and for the main SDKs a map from SDK method chain to HTTP endpoint (for example `actions.createWorkflowDispatch` to `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`).
API: `loadProviders()` (zod-validated), `getProvider(id)`, `providerForHost(host)` (exact beats wildcard, longer wildcard beats shorter), `providerForPackage(name)`, `sdkEndpoint(provider, chain)`.
How to run: `pnpm test` (4 tests in `packages/core/test/providers.test.ts`).
Not done: SDK method maps cover the common methods only; unmapped SDK calls stay "unresolved" in later tasks.
Decisions: the registry is a JSON file bundled into the build so it can later move to the open advisory repo; host patterns support only `*.` prefixes.

```
pnpm test packages/core
```
