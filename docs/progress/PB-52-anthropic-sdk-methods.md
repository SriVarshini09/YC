# PB-52: Anthropic's messages.parse() and batch methods are mapped

## Why

A-03's first live scan, on Nori, listed one call site under "Could not tell". SHAPI didn't know which endpoint `anthropic.messages.parse()` calls. That's the Anthropic SDK's structured-output helper, so model retirements were never checked for it.

## What changes

`packages/core/providers.json` maps these Anthropic SDK methods, for TypeScript and Python:

- `messages.parse` → `POST /v1/messages`;
- `messages.batches.create` → `POST /v1/messages/batches`;
- `messages.batches.retrieve` → `GET /v1/messages/batches/{message_batch_id}`;
- `messages.batches.list` → `GET /v1/messages/batches`.

The methods and endpoints are checked against the installed SDK (`@anthropic-ai/sdk` 1.1.0).

## Verified

- **Test:** `messages.parse()` resolves to `POST /v1/messages` and is affected by the Claude Sonnet 4.5 retirement when it sends that model; `messages.batches.retrieve()` resolves to its endpoint.
- **Benchmark gate and full suite:** both pass, with typecheck and lint.
