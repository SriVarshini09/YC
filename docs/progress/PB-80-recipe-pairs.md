# PB-80: Behaviour-preserving recipe pairs (execution plan C-07)

## Why

Some API changes need two edits to keep behaviour the same:

- **A model swap:** the new model often needs a parameter changed too, for example `max_tokens` becoming `max_completion_tokens`, or sampling parameters it no longer accepts.
- **A version bump:** the new version can rename a response field.

Applying only one half breaks the request or the read. The fix format couldn't change a request body at all, so model retirements had no recipe.

## What changes

- **`fix.body`** (advisory schema): for a top-level request body field, send `to` where the code sends `from` (a retired model), send it under a new name (`rename`), or stop sending it (`remove`). It goes alongside `path`, `query`, `header`, `fields` and `enums` in one fix. The published JSON Schema is regenerated.
- **TypeScript `apply-fix`** changes body fields in:
  - an SDK method's object argument (`client.chat.completions.create({ model, max_tokens })`);
  - `body: JSON.stringify({...})` (fetch), axios `data`, and got `json`;
  - each of those also through a `const` in the function or file.

  It keeps the code's quote style, and a removal takes its comma with it.
- **Python `apply-fix`** changes body fields in an SDK call's keyword arguments (`create(model="gpt-4", max_tokens=5)`) and in `json=` and `data=` dicts.
- **Contract tests read the request body:**
  - **TypeScript:** the fetch, axios and got stubs pass the body through. The fake SDK client passes the method's argument as the body, so an SDK call site with a body-only fix now gets a request test instead of "unsupported".
  - **Python:** the stubs record urllib `data`, requests `json=`/`data=`, and httpx at `Client.send` (where the OpenAI and Anthropic SDKs send), answering with a real `httpx.Response`.
  - Either test fails while a body field holds a retired value, or is still sent under a name the fix renames or drops.

No advisory changes in this PR. The fixtures use the OpenAI legacy-model advisory with a model swap and token-limit rename as test data, not as a claim about OpenAI's models.

## Verified

- **TypeScript (`recipe-pairs.test.ts`):**
  - model swap plus token-limit rename in one fix;
  - proven end to end through fetch: the baseline fails with "sent the retired request", and the fix passes;
  - the same through the OpenAI SDK's argument object;
  - version bump plus renamed field: the path moves to v26.0, and the code reads `(data.insight_count ?? data.insights_count)`.
- **Python:**
  - the pair in an SDK call's keyword arguments;
  - proven end to end through a requests `json=` body: the baseline names `model: gpt-4`, and the fix passes.
- **Schema:** the published advisory schema is regenerated and every advisory still validates.

## Release

- **Schema change:** after the deploy, mirror `schema/advisory.schema.json` to `shapi-advisories`, per the release order.
