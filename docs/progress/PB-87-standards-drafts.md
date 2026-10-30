# PB-87: Drafts of the OSV ecosystem proposal and the CycloneDX taxonomy PR (execution plan S-07)

## Why

S-07 asks for two filings: an OSV proposal for an HTTP API ecosystem, backed by demand data, and a pull request to the CycloneDX property taxonomy for the `shapi:` namespace. The founder files them; these are the drafts.

## What changes

- **`docs/standards/osv-http-api-ecosystem.md`:** the proposal for an issue on ossf/osv-schema.
  - The package is an API's host; the version is the provider-defined API version; matching details go in `ecosystem_specific`.
  - The data behind it: 87 advisories already published in OSV shape across 16 providers, 7.5% breaking spec versions in the APIs.guru history, and endpoint concentration from the provider console.
  - An example record, and open questions for the maintainers.
- **`docs/standards/cyclonedx-shapi-taxonomy.md`:** the pull request text for CycloneDX/cyclonedx-property-taxonomy, registering the `shapi:` namespace with the properties `shapi scan --sbom` writes today (checked against `packages/core/src/cyclonedx.ts`).

## Not done

- **Neither draft is filed.** Filing is the founder's (S-07's test is "both filed"), so S-07 stays open until then.
