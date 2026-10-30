# PB-69: The deprecated-shape lint (execution plan S-06)

## Why

The matcher flags call sites SHAPI can resolve. A retired name can also sit where no resolved call is: a model id in a config constant, an old enum value in a comparison, an old field read from a response stored elsewhere. A plain search for retired names catches those.

## What changes

- **Rules from verified advisories** (`deprecatedShapeRules`, `packages/core/src/lint.ts`), one per retired name:
  - model ids that `version-sunset` advisories retire (`trigger.body.model`);
  - field names their fix renames, kept to distinctive names (snake_case, camelCase, or 8+ characters) because `id` and `status` are everywhere;
  - enum values their fix renames.
  - Unverified advisories make no rules.
- **The lint** (`lintSource`, `lintFiles`):
  - a model id or enum value counts only as a whole string literal (`"gpt-4"`, not `"gpt-4o"`);
  - a field counts only where it is read (`.tax_exempt` or `["tax_exempt"]`);
  - a line already reported as affected for the same advisory isn't repeated.
- **Run on every scan:**
  - `shapi scan` prints "Retired names in the code", and `--json` adds `deprecatedNames`;
  - the MCP server's scan goes through the same code;
  - the GitHub App's scan job lints the commit's files and puts the list on the SHAPI check.
- **Demo fixture:** `fixtures/demo-ts/src/summaries.ts` keeps a retired Claude model id in a constant that no API call uses, so the lint has something to find.
- **Docs:** the quickstart lists the new report section.

## Verified

- **Unit tests** (`packages/core/test/lint.test.ts`):
  - rules come from verified advisories only, each name once;
  - plain field names are skipped;
  - whole-literal and read-only matching, with exact columns.
- **Demo (the S-06 test):** `shapi scan fixtures/demo-ts` reports exactly `src/summaries.ts:3 model claude-sonnet-4-5`, and nothing else.
- **End to end:** the GitHub App's check run for the demo lists the same line under "Retired names in the code".
- **Checks:** typecheck and lint pass, along with the core, CLI, github-app and server cloud tests. CI runs the full suite.
