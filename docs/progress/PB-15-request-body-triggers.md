# PB-15: request-body triggers, and three model-retirement advisories leave pending

## Why

Ten researched advisories waited in `shapi-advisories/advisories/pending/` because SHAPI couldn't see request bodies. Among them are the OpenAI and Anthropic model retirements: only calls that send a retired `model` break, not every call to `/v1/chat/completions` or `/v1/messages`.

## What changes

- **The api.lock records request bodies.** `surface.body` holds the top-level fields a call sends, with the value when it's a static string (unknown values are `null`). It's optional, so existing locks still parse; a call site without a known body has none. Sources:
  - **TypeScript:**
    - `fetch` / `undici` / `node-fetch` `body: JSON.stringify({ … })`;
    - axios `data` (the config form, and the second argument of `post`/`put`/`patch`);
    - got and ky `json`;
    - SDK method parameters, for example `openai.chat.completions.create({ model, … })`, `anthropic.messages.create`, `stripe.checkout.sessions.create`. Octokit's `request(route, params)` is left out, because its params mix path, query and body.
  - **Python:** `json=` / `data=` on requests, httpx and aiohttp, and SDK keyword arguments (`client.chat.completions.create(model="…")`).
  - A same-file `const` holding the object is followed, as for query parameters.
- **A new trigger condition:** `body: [{ "field": "model", "values": ["o1-mini", …] }]`.
  - The call is affected when its body sets the field to a listed value.
  - Without `values`, sending the field at all is enough.
  - A dynamic value doesn't match, so the call stays "exposed".
  - Reasons read, for example, `sends model: "o1-mini" in the request body`.
- **Schemas:** `packages/core/schema/advisory.schema.json` and `api-lock.schema.json` are regenerated.
- **Advisories:** three advisories move into the bundled `advisories/`, which brings it from 54 to 57, with `model` triggers:

| Advisory | Models |
|---|---|
| `openai-legacy-gpt-o-series-shutdown-2026-10-23` | gpt-3.5-turbo, gpt-3.5-turbo-0125, gpt-4, gpt-4-0613, gpt-4-1106-preview, gpt-4-turbo, gpt-4.1-nano, gpt-4o-2024-05-13, o1, o1-pro, o3-mini, o4-mini |
| `openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14` | the five dated snapshots only (the notice doesn't cover the undated aliases) |
| `anthropic-claude-sonnet-4-5-retirement` | claude-sonnet-4-5-20250929 and its alias claude-sonnet-4-5 |

- The demo's `api.lock` now records its Stripe `email` and GitHub `ref` body fields.

## Still pending

- **Stripe `payment_method_types` (two advisories):** they need both conditions at once, the field **and** the new API version. A trigger matches on any one of its conditions today, so promoting them would flag requests on older versions too.
- **HubSpot help-desk comments, a property write, and the QuickBooks `ORDERBY Id` query:** they need nested body paths or query-string contents.
- **Salesforce and QuickBooks plan limits:** they depend on information that isn't in the code.

Fine-tuned model names (`ft:…`) and the Responses API (`/v1/responses`) aren't matched yet.

## Order of release

1. **Merge and deploy this first.** The live app's advisory sync validates advisories with this schema; before this deploy it would reject a `body` trigger as invalid.
2. **Then merge the `shapi-advisories` PR** that moves the same three files out of `pending/`, adds `body` to that repo's schema, and updates its README and table.
3. **The CLI picks them up in its next release.** 0.3.0 doesn't have them.

## Verified

- `packages/extractor/test/body.test.ts`:
  - body fields from TypeScript SDK calls (including a const), fetch `JSON.stringify`, axios data, got json, Python SDK keyword arguments and `requests` `json=`;
  - no body on a call without one;
  - the `model` trigger hits only listed static values, with dynamic and other models exposed;
  - a field-only trigger hits only the call that sends `payment_method_types`.
- Typecheck, lint, all 42 test files (294 tests) and the docs build pass.
- In `shapi-advisories`, `npm run validate` reports 57 advisories valid and 7 pending.
