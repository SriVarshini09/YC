# Deprecated-shape lint: an enum value counts only next to its field

## Why

On launch eve, the live SHAPI check on SriVarshini09/Nori listed 18 "retired names in the code". 17 of them were `"hosted"` or `"custom"` flagged as Stripe Checkout `ui_mode` values to rename (`hosted_page`, `elements`). They sat in Nori's own LLM-credential and driver code, none of it Stripe Checkout. They appear on every push to every repository with such ordinary words.

The lint (S-06) matched retired enum values as whole string literals anywhere in any file. Model ids and field names are specific enough for that. Enum values like `hosted`, `custom` or `embedded` are not.

## What changes

- Enum rules carry their field (`ui_mode`).
- `lintSource` counts an enum value only in a file that also names that field: `ui_mode`, or its camelCase form `uiMode`.
- Model-id and field rules are unchanged.

## Verified

- New test: a credentials module with `"hosted"` and `"custom"` and no `ui_mode` gets no findings. A Checkout call with `ui_mode: "hosted"` and a `session.ui_mode === "custom"` comparison is still flagged, and so is camelCase `uiMode` code.
- On a fresh clone of Nori, the CLI built from this branch reports 1 retired name, down from 18: `packages/core/src/llm/chat-body.test.ts:19 model o4-mini`, a real retired OpenAI model.
- The lint and CLI demo tests pass.
