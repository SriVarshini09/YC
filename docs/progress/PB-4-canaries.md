# PB-4 canaries for five more providers

What exists: canary workers for **Slack, OpenAI, Anthropic, Twilio and HubSpot**, alongside GitHub and Stripe. The hosted worker already runs every canary on `CANARY_CRON` (hourly at :07) and stores shapes in Postgres. Each new worker starts probing as soon as its key is set as a Fly secret, and skips with a reason until then.

| Provider | Probes | Key |
|---|---|---|
| Slack | `GET /api/api.test` (no key, so it runs today), `auth.test`, `conversations.list?limit=1` | `SHAPI_SLACK_BOT_TOKEN`; only `xoxb-` bot tokens are accepted |
| OpenAI | `GET /v1/models` | `SHAPI_OPENAI_API_KEY` |
| Anthropic | `GET /v1/models` with `anthropic-version: 2023-06-01` | `SHAPI_ANTHROPIC_API_KEY` |
| Twilio | `POST …/Messages.json` from the magic test number `+15005550006` | `SHAPI_TWILIO_TEST_ACCOUNT_SID` (must look like `AC` + 32 hex) and `SHAPI_TWILIO_TEST_AUTH_TOKEN` |
| HubSpot | `GET /crm/v3/objects/contacts?limit=1`, `GET /crm/v3/pipelines/deals` | `SHAPI_HUBSPOT_TOKEN` (a developer test account's private-app token) |

Why these probes:
- **They're free and harmless.** All are list or read calls, except Twilio's, which uses test credentials: Twilio delivers nothing and charges nothing for a message from a magic number.
- **They match endpoints that advisories cover,** so a shape change there can draft an advisory and feed `shapesFor` for fixes.
- **The values never leave the store.** Shapes keep status codes, field names, types and value classes, never values, like the existing canaries.

The README has the full table of canary providers and keys.

Verified: tests for each worker's probes from its environment, the refusals (non-bot Slack token, malformed Twilio SID), and a full run of all eight new probes against a fake server that stores a shape for each. 244 tests pass, plus lint and typecheck.

Needs you: create the accounts and give the keys through the hidden prompt. Until then, the new probes skip, except Slack's `api.test`, which needs no key.
