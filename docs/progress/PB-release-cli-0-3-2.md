# shapi-cli 0.3.2 on npm

What's new since 0.3.1:
- **87 bundled advisories, up from 57.**
  - Every Stripe breaking change on a mapped method (C-05) and every Shopify Admin API breaking change (C-06) now has one.
  - Advisories can match the GraphQL operations a call sends.
  - Every verified advisory carries the provider's exact quote (C-02).
  - Unverified advisories never open PRs (C-03).
- **Python fixes (U-03).** `fix` repairs Python call sites with the `apply-fix` and `status-code-accept-set` recipes. It installs the repository's dependencies and runs its pytest suite before and after the fix.
- **Go scanning (U-07).** `scan` maps `net/http` calls; fixes stay TypeScript, JavaScript and Python.
- **Safer fixes.** A fix must:
  - keep the repository's own tests passing (V-01);
  - not edit, remove or skip them (V-02);
  - not delete the call or the read of what changed (V-06);
  - survive the undo check (V-04) and the scope check (V-05).
- **More output formats:**
  - api.lock as a CycloneDX 1.7 SaaSBOM (S-02);
  - advisories as OSV records and scan verdicts as OpenVEX (S-03);
  - advisories as OpenAPI Overlays and Arazzo workflows (S-05);
  - the deprecated-shape lint (S-06).
- **Two fixes found by the launch smoke test:**
  - **Scans skip SHAPI's own contract tests** (6c3b21f). 0.3.1 reported the generated test as a HIGH finding after a SHAPI fix PR was merged.
  - **Rename contract tests give each field its own value** (#150). 0.3.1 called a Stripe `ui_mode` comparison "already handled" when the function returned a different field for the new value.
- Call sites SHAPI can't place are reported as unresolved (A-03). There are also fewer false matches (Gemini SDK models, `{repo}` path parameters, models held in variables).

The only change in this PR is the version (`packages/cli/package.json`, `VERSION`) and the demo `api.lock`'s generator line.

## Verified before publishing

- `pnpm pack:cli` builds `shapi-cli@0.3.2`, and its smoke test passes: version, scan, `--json`, Python and `fix`.
- The packed tarball, installed in an empty folder, on a fresh clone of shapi-demo:
  - `scan` of main reports no affected call sites. 0.3.1 flagged `test/shapi/hubspot-pipelines-v1-sunset.test.ts:63`.
  - With a Checkout call that compares `session.ui_mode` to `"embedded"` added, `fix` reports `FIXED … via recipe (apply-fix)`. 0.3.1 said `ALREADY-HANDLED`.

Publishing needs the founder's npm login: the token on the build machine is expired (401).
