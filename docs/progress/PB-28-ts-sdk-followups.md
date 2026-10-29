# PB-28 TS SDK follow-ups: GraphQL clients, Slack Bolt, Twilio sid chains, AU Payroll v2

These are the gaps PB-24 listed under "Not done", plus a Slack Bolt gap and a check of how loose URLs count as resolved. Each one was reproduced with a failing test first. The tests are in `packages/extractor/test/sdk-chains.test.ts`, and there are new marked lines in `advisory-matching.test.ts`.

## Why

Some SDK calls never reached their endpoint, so their advisories could not fire:

- `shopify.graphql()` from shopify-api-node was mapped to `POST /graphql`, which is GitHub's path.
- `client.request(query)` from `@shopify/admin-api-client` was read as an Octokit route, so it resolved to nothing.
- Bolt's `app.client.files.upload(...)` and the `client` a listener receives were not looked up in the Slack Web API table.
- `client.messages(sid).fetch()` broke the method chain at the call. It was recorded as an unresolved `messages` call, so the SDK's `errorCode` reads were never matched.

## What changes

- **GraphQL per provider:** the hard-coded `graphql → POST /graphql` is gone. `graphql` is now an entry in each provider's table: GitHub's is `POST /graphql`, and Shopify's is `POST /admin/api/{version}/graphql.json`. Shopify's table also maps `request` to that endpoint, because `request(query)` is how `@shopify/admin-api-client` sends a query. `shopify-non-expiring-offline-tokens-rejected` now fires on both.
- **`request(route)`:** a static string is read as a route only for Octokit, or when it has the form `METHOD /path`. Any other string falls through to the provider's table. For `request`, the options are always the second argument, so headers passed with a query are recorded. A GraphQL client's variables are not request-body fields.
- **Slack Bolt:** for `@slack/bolt`, `app.client.<method>` is looked up as `<method>` in the Slack table. The `client` destructured from a listener's argument (`app.command(…, async ({ client }) => …)`, including `{ client: web }`) is the Web API client. This applies to `message`, `event`, `command`, `action`, `shortcut`, `view`, `options`, `function` and `use`.
- **Twilio sid chains:** in an SDK chain, a call keeps empty parentheses (`client.messages(sid).fetch()` has the operation `messages().fetch`). The Twilio table maps `messages()`, `calls()` and `conferences()` with `fetch`, `update` (and `remove` for messages and calls) to `/2010-04-01/Accounts/{AccountSid}/{Messages|Calls|Conferences}/{Sid}.json`. The inner `client.messages(sid)` is not recorded separately when the longer chain resolves. A chain with a call that the table doesn't know is not a call site of its own, so `openai.responses.create(…).then(…)` is still recorded once, as `responses.create`.
- **Loose URLs:** I checked them and changed nothing. `callsites.ts` and `python.ts` record them as `resolved: true` with `method: null`, as `lockfile.ts` documents. The CLI report and the MCP `scan` tool both count `!resolved`, so loose URLs are not in the "unresolved" count, which matches the doc. A test now pins this.
- **Docs:** `site/guide/how-it-works.md` names the GraphQL clients, Bolt and Twilio sid chains.

## Advisories

Mirror these changes to `SriVarshini09/shapi-advisories`:

| Advisory | Change |
|---|---|
| `twilio-rcs-undelivered-error-code-30046` | Adds the enum field `errorCode` (values `["30036"]`): the Node.js SDK's name for the Message resource's `error_code`. The migration note names it. No dates or facts changed. |
| `xero-au-payroll-isqualifyingearnings-required-earningsrates` (new) | Same facts as `xero-au-payroll-isqualifyingearnings-required`. Covers `POST /payroll.xro/2.0/earningsRates`, which the original's summary and migration note name but its endpoint doesn't cover. |

## Not done

- `@shopify/shopify-api`'s `new shopify.clients.Graphql({ session })` is not followed. It is built from a member of the `shopifyApi()` result, so `client.request(...)` on it isn't recognized.
- shopify-api-node without `apiVersion` posts to `/admin/api/graphql.json`. The table always records the versioned path.
- Path matching is case-sensitive. The new Xero advisory uses `earningsRates`, as the advisory's facts spell it. A call written as `/EarningsRates` won't match.

## Verified

- `packages/extractor/test/sdk-chains.test.ts`: the GraphQL, `request(query)`, Bolt and Twilio tests failed on main. The loose-URL test passes on main and pins the documented behavior.
- `packages/extractor/test/advisory-matching.test.ts`: new marked lines for `shopify.graphql`, `client.messages(sid).fetch()` with `errorCode`, and `POST /payroll.xro/2.0/earningsRates`. The Xero line fails without the new advisory.
- `fixtures/demo-ts/api.lock` did not change (`packages/cli/test/demo.test.ts`).
- `pnpm typecheck` and `pnpm lint` pass, and so do `pnpm vitest run packages/extractor packages/core packages/cli packages/mcp`. CI runs the full suite.
