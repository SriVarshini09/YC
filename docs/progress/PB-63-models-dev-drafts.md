# PB-63: models.dev deprecations become drafts (execution plan C-04)

## Why

The OpenAI spec replay (P-10) showed model deprecations are invisible in OpenAI's spec: it keeps a deprecated model in its enums with nothing marking it. models.dev tracks each model's status across providers, so it's a second source SHAPI can read every day.

## What changes

- **`pnpm canary models-dev`** (`packages/canary/src/models-dev.ts`) reads models.dev's `api.json`.
  - For every model marked `status: "deprecated"` on a host in `providers.json`, it writes an unverified `version-sunset` draft to `advisories/drafts/`.
  - The host comes from the provider's `api` URL, or from the default host of its AI SDK package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`).
- **Each draft's trigger** is `body.model` with the model's id. Gemini also gets `models/<id>`, as its other advisories have.
- **Endpoint by provider:**
  - OpenAI: `POST /v1/**`;
  - Anthropic: `POST /v1/messages`;
  - Gemini: the `models/{model}:*` pattern.
- **Dates:** models.dev has no shutdown date, so `effectiveDate` is the day the model was first seen deprecated. A later run keeps that date, and a person adds the real date and the replacement when verifying.
- **Drafts never open PRs** (C-03), and `loadAdvisories` skips `drafts/`.
- **First run, 2026-10-30:** 14 drafts, 12 OpenAI and 2 Gemini. Anthropic has no deprecated models on models.dev today.

Running it every night needs a schedule (a GitHub Actions workflow or a server job). That's left for the founder to approve, since it would change the repository on its own.

## Verified

- **Unit tests** (`packages/canary/test/models-dev.test.ts`):
  - every deprecated model on a known host is drafted; unknown hosts, current models and bad URLs are skipped;
  - drafts validate against `AdvisorySchema`;
  - the Gemini trigger and endpoint;
  - a draft flags a call sending the deprecated model and not one sending another, through the real matcher;
  - the CLI writes the drafts, and a second run keeps each first-seen date.
- **Checks:** typecheck, lint and the canary tests pass. CI runs the full suite.
