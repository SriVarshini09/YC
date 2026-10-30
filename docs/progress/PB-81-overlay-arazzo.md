# PB-81: Advisories as OpenAPI Overlays and Arazzo workflows (execution plan S-05)

## Why

Some providers publish their OpenAPI spec. For those, an advisory can be said in the provider's own format: the spec as it is after the change, and a workflow that shows the change. API tooling can then read SHAPI's advisories without knowing SHAPI's schema.

## What changes

- **`packages/core/spec-sources.json` pins each published spec to a commit:**
  - GitHub: `github/rest-api-description`;
  - OpenAI: `openai/openai-openapi`;
  - Stripe: `stripe/openapi`;
  - Twilio: `twilio/twilio-oai` (Messaging, Voice Insights, Notify).
- **`bench:spec-excerpts`** fetches each spec at its commit and writes the operations the provider's advisories touch to `datasets/spec-excerpts/<provider>.json`. Each operation keeps its operationId and response codes. The script then applies every overlay to the full spec and exits 1 if any target is missing.
- **`advisoryToOverlays`** (OpenAPI Overlay 1.0.0) is the after-spec, extending the raw spec file at the pinned commit:
  - a shutdown removes the operation;
  - a status-code change removes the retired 2xx response and adds the new one;
  - every operation the advisory covers gets `x-shapi-advisory`, `x-shapi-change-class` and `x-shapi-effective-date`.
- **`advisoryToArazzo`** (Arazzo 1.0.1) is the proving flow: one step per operation, at most 10, with what the provider answers after the change:
  - the new status code;
  - a failure for a shut-down operation;
  - a failure when the body sends the retired value.
- **`applyOverlay`** applies the JSONPath forms the generator writes and lists any action whose target matched nothing.
- **Published at:**
  - `shapi.dev/overlays/<id>.overlay.json`;
  - `shapi.dev/arazzo/<id>.arazzo.json`.

  Both are served to any origin. "How SHAPI works" mentions them, along with the OSV records.

## Result

**All 18 overlays apply cleanly** to the full specs at the pinned commits: every advisory with operations in its provider's published spec is covered.

| Provider | Advisories |
|---|---|
| GitHub | 1 |
| OpenAI | 8 |
| Stripe | 5 |
| Twilio | 4 |

Anthropic publishes no OpenAPI spec, so its advisories have none.

## Verified

- **Every overlay and workflow validates** against the official Overlay 1.0 and Arazzo 1.0 JSON schemas.
- **Every overlay applies to its excerpt** with no unmatched target, and extends the pinned commit's file.
- **Behaviour:**
  - the GitHub dispatch overlay drops 204 and marks the operation;
  - the OpenAI translations shutdown removes `POST /audio/translations`.
- **The published files are in sync** (`UPDATE_SPECS=1` rewrites them).
- **Applier unit tests:** bracket and dot targets, escaped quotes, removal, deep merge, unmatched targets, and unsupported JSONPath refused.
- **Server:** `/overlays/` and `/arazzo/` are served with `access-control-allow-origin: *`.
