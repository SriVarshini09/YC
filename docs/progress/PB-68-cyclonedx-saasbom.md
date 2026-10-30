# PB-68: api.lock as a CycloneDX 1.7 SaaSBOM (execution plan S-02)

## Why

Security and procurement teams already collect SBOMs. CycloneDX's SaaSBOM records the external services an application calls. SHAPI's `api.lock` holds exactly that, down to the line, so exporting it puts SHAPI's inventory in a format those tools read without new integrations.

## What changes

- **`apiLockToCycloneDx()`** (`packages/core/src/cyclonedx.ts`) turns an api.lock into a CycloneDX 1.7 BOM:
  - **Services:** each provider, with its endpoints. Templated segments like `{owner}` are percent-encoded so the IRIs are legal; the templates and operations stay in `shapi:operation` properties.
  - **Components:** each client the code calls through (an SDK package, `fetch`, `axios`) is a `library`. Its `evidence.occurrences` are the call sites: file, line, column, operation and the lock's call-site id.
  - **Properties** under the `shapi:` namespace: provider, call-site counts, unresolved call sites, lockfile version, generator.
  - The repository is `metadata.component`, with the commit as its version.
  - The serial number comes from the content, so the same lock always exports to the same bytes.
- **`shapi scan --sbom <file>`** writes it next to the scan.
- **One URL per repository:** `/a/<account>/r/<repo>/sbom.cdx.json` serves the latest scan's SBOM to people who can open the repository. The repository page links to it.
- **Docs:** the CLI guide lists `--sbom`.

## Verified

- **Schema:** validated against the official CycloneDX 1.7 JSON schema (and the SPDX, JSF and cryptography schemas it references), vendored under `packages/core/test/fixtures/cyclonedx/`. That's the schema `cyclonedx-cli validate` checks JSON against. Running the CLI binary itself needs a download, which is the founder's call.
- **Content and determinism:** services and endpoints, every call site as evidence, the same bytes twice, a new serial number for a new commit.
- **CLI:** `--sbom` writes the same file twice, with all three of the fixture's call sites.
- **Web:** 404 before any lock; then the SBOM with the right content type, file name, repository name and commit; the repository page links it; signed-out requests and another account's repository don't get it.
- **Checks:** typecheck, lint, and the core and CLI tests pass. CI runs the full suite.
