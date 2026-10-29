# PB-24: matcher and advisory fixes from the full review

## Why

Review 3 (extractor and core) found advisories that could never fire on idiomatic code, and matcher gaps behind them:

- a URL sent by a project's own helper (method unknown) never matched an advisory that names a method;
- whole SDKs had no method table, so their calls were unresolved and matched nothing;
- several advisories used field paths, endpoints or trigger kinds that real code never produces;
- an SDK chain named `toString` crashed the whole scan.

## What changes

**Matcher and schema (`packages/core`)**
- **Unknown method or host is "possibly affected".** A site whose path matches but whose method is null (a loose URL), or whose host is unknown while the advisory names hosts, now lands in `possible`. The reason reads, for example, `calls ? /api/files.upload, but SHAPI cannot tell the method (affected if it is POST)`.
- **Enum triggers take an optional `values` filter:** `enums: [{ "field": "error_code", "values": ["30036"] }]` is affected only when the code compares the field to a listed value.
- **Stricter triggers.** A trigger needs `any: true` or a non-empty `statusCodes`, `fields`, `enums`, `headers`, `query` or `body`. `newStatusCodes` alone, or `fields: []`, can never fire and is now rejected.
- **The generated `schema/advisory.schema.json` matches zod.** It is generated in input mode, so unknown keys such as `$schema` are allowed, as zod strips them. The trigger and fix "at least one" rules are spelled out with `anyOf`. The non-standard `format: "starts_with"` is gone, because `path` now uses a plain pattern. Copy this file to the public repository's `schema/`.
- **`sdkEndpoint` reads only own keys of the method table,** so `stripe.toString()` no longer throws.
- **Docs only:**
  - `daysUntil` and `effectiveDate` are documented as UTC calendar days.
  - `resolved` is documented as also true for loose URLs, whose method stays null.

**Extractor (`packages/extractor`)**
- **A TS/JS file the extractor fails on is listed in `skipped`** with the error, instead of aborting the scan.
- **Numeric comparisons on body fields are recorded as enum values,** as their decimal string (`msg.error_code === 30036` gives `error_code: ["30036"]`). This change is in `surface.ts` and touches only the enum recording.

**SDK method tables (`packages/core/providers.json`)**
- **Slack:** `files.upload`. `files.uploadV2` now maps to `files.completeUploadExternal`, the method the helper ends in; it used to map to a nonexistent `/api/files.uploadV2`. `files.getUploadURLExternal` and `files.completeUploadExternal` are added too.
- **OpenAI (Node):** `audio.translations/transcriptions.create`; `evals.*` and `evals.runs.*`; `beta.assistants.*`; `beta.threads.*`, including `messages.*`, `runs.*` and `createAndRun*`; `responses.parse/stream`; `chat.completions.parse/stream`. Python gains the threads `messages`, `runs.retrieve` and `runs.create_and_poll`.
- **`@google/genai`:** `models.generateContent`, `generateContentStream`, `countTokens`, `embedContent` and `generateImages`. The path is `/v1beta/models/{model}:…`, because the model goes in the body.
- **Shopify:** the `shopify-api-node` `scriptTag.*` methods, and the `@shopify/shopify-api` REST resource `ScriptTag.all/find/delete/count`.
- **Xero (`xero-node`):** `getOrganisations` and the common invoice, contact, payment, bank transaction and manual journal methods; `emailInvoice`; the credit note, overpayment and prepayment allocations; `payrollAUApi.createPayItem`; `payrollNZApi.updateEmployeeTax`; and the four `financeApi.getAccountingActivity*` methods.
- **Salesforce (`jsforce`):** `login`/`loginBySoap` map to `POST /services/Soap/u/{version}`. The version and host are unknown, so the three SOAP-login advisories report these calls as possibly affected. That is right, because `login()` uses OAuth2 instead when a client id and secret are configured.
- **X (`twitter-api-v2`):** `v2.follow/unfollow/like/unlike`, and `readWrite.v2.follow/like`.
- **QuickBooks:** the `node-quickbooks` methods `getCompanyInfo`, invoice and customer get/create/find, and `refreshAccessToken`; the `intuit-oauth` methods `refresh`, `refreshUsingToken` and `createToken`.
- **Twilio (Node):** `conferences.list/each/page` and `messages.list`.

**Advisories.** Mirror every change below to `SriVarshini09/shapi-advisories`. No dates or facts were changed; only matching and the wording that says what each advisory covers.

| Advisory | Change |
|---|---|
| `quickbooks-companyinfo-neoenabled-removed` | Trigger `fields: ["NeoEnabled"]` changed to `enums: [{ field: "CompanyInfo.NameValue[].Name", values: ["NeoEnabled"] }]`, because NeoEnabled is a NameValue entry that code finds by `Name`. |
| `xero-organisation-class-ultra-enum` | Enum field `Organisations[].Class` added (the response wraps the organisation in `Organisations[]`); `Class` is kept. |
| `meta-graph-delivery-estimate-fields-removed` | Fields `data[].daily_outcomes_curve`, `data[].budget_guardrail` and `data[].estimate_dau` added (the edge returns `{ data: [...] }`). Path changed to `/**/delivery_estimate` so unversioned calls match. |
| `twilio-rcs-undelivered-error-code-30046` | Enums now `error_code` and `messages[].error_code`, with `values: ["30036"]`; numeric comparisons now record them. Path widened to `Messages**` so the list endpoint is covered too. |
| `x-activity-api-pascalcase-event-types-removed` | Enum fields `data.event_type` and `data[].event_type` added (X wraps payloads in `data`), plus `body: [{ field: "event_type" }]` for subscriptions created with the old names. |
| `stripe-checkout-session-ui-mode-values-renamed` | `body: [{ field: "ui_mode", values: ["hosted", "embedded", "custom"] }]` added, because creating a session with an old value fails. |
| `meta-graph-instagram-oembed-fields-removed` | Path changed from `/*/instagram_oembed` to `/**/instagram_oembed`, so unversioned calls match. |
| `meta-graph-commerce-order-management-removed` | Path changed from `/*/*/commerce_orders` to `/**/commerce_orders`, for the same reason. |
| `meta-graph-page-insights-impressions-fans-removed` | Path changed from `/*/*/insights` to `/**/insights`, for the same reason. |
| `meta-graph-page-insights-reach-video-views-removed` | Path changed from `/*/*/insights` to `/**/insights`, for the same reason. |
| `openai-assistants-threads-api-shutdown` (new) | Covers `* /v1/threads/**`, which the Assistants shutdown notice includes. The original advisory covers `/v1/assistants/**` only. |
| `openai-gpt-4o-gpt-4-1-snapshots-shutdown-2027-01-14-responses` (new) | Covers `POST /v1/responses` with the same models; the original's migration note says the Responses API uses the same names. |
| `openai-legacy-gpt-o-series-shutdown-2026-10-23-responses` (new) | Covers `POST /v1/responses` with the same models; the original's migration note says they stop working there too. |
| `google-gemini-2-0-flash-shutdown-sdk` (new) | Covers `POST /*/models/*:*` with `body.model`: `@google/genai` sends the model as a parameter, which the path-based original says it doesn't match. The `models/…` prefixed names are included. |
| `google-gemini-2-5-flash-image-shutdown-sdk` (new) | Same as above, for gemini-2.5-flash-image. |
| `google-gemini-2-5-preview-tts-shutdown-sdk` (new) | Same as above, for the two preview TTS models. |

Siblings rather than a multi-endpoint schema: one advisory still names one endpoint, so every consumer that shows `endpoint.method endpoint.path` keeps working, and older CLIs read the new files unchanged.

**Docs:** how-it-works and quickstart describe the new "possibly affected" case, and how-it-works now says effective dates are UTC days.

## Not done

- **CompanyInfo from the QuickBooks query endpoint.** Widening the NeoEnabled endpoint to `/v3/company/{realmId}/**` would make every QuickBooks GET "exposed" to it. Covering it needs a query-value condition on the endpoint.
- **Shopify GraphQL through the SDKs.**
  - `@shopify/admin-api-client`: `client.request(query)` with a static query is treated as an Octokit-style route.
  - `shopify-api-node`: `shopify.graphql()` is hard-mapped to `POST /graphql`.
  - Both live in `callsites.ts`. Admin API version sunsets reach SDK calls as "possibly affected" through the `{version}` segment.
- **Twilio SDK camelCase fields.** `errorCode` on `client.messages(sid).fetch()` can't be matched: the chain breaks at the call.
- **AU Payroll v2.** The isqualifyingearnings summary also names `POST /payroll.xro/2.0/earningsRates`, which the advisory's endpoint doesn't cover.

## Verified

- `packages/extractor/test/advisory-matching.test.ts` holds idiomatic TS for every advisory above and each new SDK table. Each line is marked with the advisories it must be affected by, possibly affected by or exposed to. Unmarked lines must be neither affected nor possible. On main the test fails at the first SDK call.
- `packages/extractor/test/bad-file.test.ts`: `stripe.toString()` / `constructor()` / `hasOwnProperty()` no longer crash the scan. On main it failed with `ref.split is not a function`. A file whose surface pass throws is listed in `skipped` while the other files are scanned.
- `packages/core/test/matcher.test.ts`: unknown method, unknown host, enum `values` filter, and UTC day counts.
- `packages/core/test/advisory.test.ts`: triggers that can never fire are rejected. The generated schema uses only standard keywords and formats, and a small validator built on those keywords accepts every seeded advisory, including one with an extra `$schema` key. It rejects `trigger: {}`, `{ newStatusCodes }` alone, `fields: []`, `fix: {}` and a path without a leading `/`.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
