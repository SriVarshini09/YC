# shapi-cli 0.2.0 on npm

What exists: **shapi-cli 0.2.0** is published to npm as `latest` (https://www.npmjs.com/package/shapi-cli), built from commit "chore: shapi-cli 0.2.0" on this branch. It's the CLI from PB-1 to PB-7:
- 54 advisories;
- Python scanning;
- `apply-fix` (versions, query values, headers, renamed fields and enum values);
- contract tests for axios, got and SDKs;
- one change per advisory covering all its call sites.

The package has 12 dependencies, including `web-tree-sitter`, and ships the Python grammar as `dist/tree-sitter-python.wasm`.

Verified from an empty folder with `npx -y shapi-cli@0.2.0`:
- `--version` prints 0.2.0;
- `scan` of the demo finds its 3 affected call sites;
- `scan` of the Python fixture finds 9 call sites across 8 providers, 6 of them affected;
- `fix demo --write` reports FIXED for all 3, and a rescan shows 0 affected call sites.

The packaging smoke test (`pnpm pack:cli`) passed before publishing. The only change in this PR is the version (`packages/cli/package.json`, `VERSION`) and the demo `api.lock`'s generator line.
