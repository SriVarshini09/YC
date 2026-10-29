# PB-33 Review 7: Gemini SDK advisories, extractor symbol tables and noise

Fixes for review 7's findings #7 and #8, two of its minor notes (`public/` skipped everywhere, `Object.prototype`-named SDK calls), and the Slack Bolt note from PR #79. Each one was reproduced with a failing test first.

## Why

- **#7, Gemini `-sdk` advisories:** the three `-sdk` siblings had the path `/*/models/*:*`, so every Gemini call site matched them. A REST call that names its model in the path, such as `/v1beta/models/gemini-2.5-pro:generateContent`, was "exposed" to all three shutdowns. A REST call to `gemini-2.0-flash` was affected by the original advisory and also exposed by its `-sdk` sibling, so one shutdown showed as both "breaks" and "still working". The CLI and web count findings, so these extra findings inflated "still working" and the deadlines' call-site counts.
- **#8, half-built symbol tables:** `contextOf` cached a file's symbol table before filling it. Since cross-file client imports are followed, a collector that throws for `src/client.ts` while `src/a-use.ts` follows an import into it made `a-use.ts` the skipped file, with `client.ts`'s error. `client.ts` was then scanned from the half-built table, with clients missing, and never listed as skipped.
- **`public/`:** every folder named `public` was skipped, so source under `src/public/` and Python packages named `public` were not scanned.
- **`Object.prototype` names:** `stripe.toString()`, `stripe.constructor()` and `stripe.customers.valueOf()` were recorded as Stripe call sites with no endpoint.
- **Slack Bolt:** `app.command(...)`, `app.event(...)`, `app.error(...)` and `app.start()` were recorded as unresolved Slack SDK calls, which inflated the "could not be fully resolved" count. They register listeners or start the app; they are not Web API calls.

## What changes

- **Path pattern `{?}`:** in an advisory's path, `{?}` matches only a value the code builds at runtime (a call-site parameter such as `{model}`), never a literal (`packages/core/src/matcher.ts`). The three `-sdk` siblings now use `/*/models/{?}:*`. They match the SDK's `/v1beta/models/{model}:…` and a REST call whose model is a variable, and no longer match a call that names the model in its path, which the path-based original covers. A matcher without `{?}` reads it as `{name}` (any one segment), which is how these advisories matched before, so older CLIs are not broken by the new JSON. The schema comment and `advisories/README.md` document `{?}`.
- **OpenAI `-responses` and Xero `-earningsrates` siblings:** checked, no change. They cover a different endpoint from their originals (`/v1/responses` against `/v1/chat/completions`, and `/payroll.xro/2.0/earningsRates` against `/payroll.xro/1.0/PayItems`), so no call site is counted by both. Every `/v1/responses` call is exposed to the `-responses` advisories, as every chat completion is exposed to the originals. An SDK Gemini call with another model is still exposed to each of the three `-sdk` shutdowns in the same way.
- **Symbol tables:** `contextOf` caches a file's table only after the three collectors succeed. When a table for an imported file fails to build, the import resolves to no client (`importedContext`), so the importer keeps its other call sites, and the failing file is listed as skipped on its own turn.
- **`public/`:** skipped only at the repository root or next to a `package.json`, where Next.js, Vite, Laravel and similar frameworks keep static files. Minified bundles (`*.min.js`, `*.bundle.js`) are still skipped everywhere.
- **`Object.prototype` names:** an SDK chain whose last name is an `Object.prototype` member is not recorded, unless the provider's method table names it.
- **Slack Bolt:** on a Bolt App, only `app.client.…` chains are recorded. The `client` a listener receives is still the Web API client.
- **Docs:** `site/guide/how-it-works.md` describes the `public/` rule and the Bolt App's own methods.

## Advisories

Mirror these changes to `SriVarshini09/shapi-advisories`:

| Advisory | Change |
|---|---|
| `google-gemini-2-0-flash-shutdown-sdk` | `endpoint.path` from `/*/models/*:*` to `/*/models/{?}:*`. No facts or dates changed. |
| `google-gemini-2-5-flash-image-shutdown-sdk` | The same path change. |
| `google-gemini-2-5-preview-tts-shutdown-sdk` | The same path change. |

Also mirror the `{?}` sentence in `advisories/README.md`, if the public repository's README describes the path patterns.

## Verified

- `packages/extractor/test/advisory-matching.test.ts`, "keeps a Gemini call that names the model in its path out of the advisories for a model passed as a parameter": REST `gemini-2.0-flash` and `gemini-2.5-pro` calls are exposed to no `-sdk` advisory. It failed on main, where the 2.0-flash REST call was exposed to all three. A new marked line pins that a REST call with a runtime model is still exposed to `google-gemini-2-0-flash-shutdown-sdk`.
- `packages/core/test/matcher.test.ts`, "matches {?} only against a value the code builds at runtime".
- `packages/extractor/test/bad-file.test.ts`, "is skipped itself when another file imports a client from it, and the importer keeps its other calls": it failed on main, where `src/a-use.ts` was skipped with `src/client.ts`'s error. The first test there no longer expects the `toString`, `constructor`, `hasOwnProperty` (and now `valueOf`) sites; it failed on main.
- `packages/extractor/test/ts-shapes.test.ts`, "skips public/ only at the root and next to a package.json, where frameworks serve static files from": it failed on main.
- `packages/extractor/test/sdk-chains.test.ts`, "does not record the App's own methods, which register listeners or run the app, as Web API calls": it failed on main.
- `pnpm typecheck` and `pnpm lint` pass, and so do `pnpm vitest run packages/extractor packages/core packages/cli packages/mcp`. CI runs the full suite.
