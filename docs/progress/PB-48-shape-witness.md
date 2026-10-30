# PB-48: One shared shape record, the shape witness (execution plan A-01)

## Why

The canary stored response shapes in its own format, the recorded fixtures were raw responses, and nothing else could describe a response. Spec-history replay, fixtures for contract tests, the canary back-test and (later) opt-in customer traffic all need one record type. Then a change seen anywhere can be compared with a change seen everywhere, and the record has to be safe to share.

## What changes

- **`packages/shapes/src/witness.ts`** holds `WitnessSchema`, `toWitness()`, `shapeId()` and `witnessJsonSchema()`. A witness records:
  - the endpoint: provider, method, path template;
  - the API version that answered (a version header, or the version the request asked for);
  - the status, the contract headers' names, and RFC 9745 `Deprecation` and RFC 8594 `Sunset` as ISO dates;
  - the body as typed key paths: `$.data[].id: "string:uuid"`, `$.merged_at: "null|string:datetime"`.
- **Values are zeroed.** Fields keep JSON types and, for strings, a format class, never a value. Enum values stay in clear only for paths the allowlist names (`enums`).
- **The key allowlist fails closed.** `keys: "*"` records every key, which is what SHAPI's own canary accounts use. A list records only those paths and the objects on the way to them; other paths are dropped and counted. An empty list records no body keys.
- **Map collapse.** An object keyed by data (ids, uuids, dates, emails, numbers, or more than 32 keys) becomes a map, `$.users{}`, and its keys are never recorded.
- **`shapeId`.** The sha256 of the canonical witness, without `observedAt` and `source`. The same response gives the same id on every run and from every source, and more items of the same structure give the same id.
- **Emitters:**
  - the canary attaches a witness to every probe result (source `canary`);
  - `replay()` returns a witness per recorded response (source `replay`);
  - `fixtures/witnesses/github-workflow-dispatch-204-to-200.json` holds the recorded incident's three witnesses, ready for V-03's fixtures-from-witnesses.
  - The benchmark records no HTTP responses yet; its before/after witness pairs come with the canary back-test (P-11).
- **Published schema.** The witness JSON Schema is at `https://shapi.dev/schema/witness-v1.json` (`site/public/schema/witness-v1.json`), next to the advisory schema.

## Verified

- **Tests:**
  - **Zeroing:** a GitHub pulls response gives the expected typed paths, and none of its values (email, login, id, title, state, node id) appear anywhere in the witness.
  - **Stable id:** same `shape_id` across runs and sources, and with more items; a changed type changes it.
  - **Allowlist:** enum values in clear only for allowlisted paths. With an empty list only the root is kept and the drop is counted; with a list, exactly the named paths and their parents.
  - **Maps:** objects keyed by uuids or with over 32 keys collapse, and their keys are absent.
  - **Headers:** the Deprecation structured date, the Sunset HTTP-date, and a version taken from the request.
  - **Schema:** the published file matches the generator.
  - **Canary:** every probe carries a witness, the `shape_id` holds across unchanged runs and changes when the dispatch endpoint goes from 204 to 200, and the run URL never appears.
  - **Replay:** three witnesses for the recorded incident, the two 204s sharing one id, and byte-identical to the committed fixture on a second run.
- **Full suite:** typecheck, lint and the full test suite.
