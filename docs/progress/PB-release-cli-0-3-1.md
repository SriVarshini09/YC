# shapi-cli 0.3.1 on npm

What's new since 0.3.0:
- **Request-body triggers (PB-15).** `scan` reads the top-level body fields a call sends, and advisories can match on them.
- **Three model-retirement advisories** that fire only on calls sending a retired model:
  - OpenAI's legacy models (2026-10-23);
  - the gpt-4o and gpt-4.1 snapshots (2027-01-14);
  - Claude Sonnet 4.5 (2026-11-30).

  57 bundled advisories, up from 54.
- **Five advisories re-checked against primary sources (PB-17):** four are now verified, and Reddit's is corrected.

The only change in this PR is the version (`packages/cli/package.json`, `VERSION`) and the demo `api.lock`'s generator line.

## Verified before publishing

- `pnpm pack:cli` builds `shapi-cli@0.3.1`, and its smoke test passes: version, scan, `--json`, Python and `fix`.
- The packed tarball, installed in an empty folder, scans a file with three `chat.completions.create` calls:
  - `model: "o1-pro"` is affected by the legacy-model shutdown ("sends model: "o1-pro" in the request body");
  - `model: "gpt-5"` and a variable `model` are listed as exposed, not affected.

Publishing needs the founder's npm approval after merge.
