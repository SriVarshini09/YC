# Draft: register the `shapi:` namespace in the CycloneDX property taxonomy

*Execution plan S-07. A draft for the founder to file as a pull request on [CycloneDX/cyclonedx-property-taxonomy](https://github.com/CycloneDX/cyclonedx-property-taxonomy). Nothing here has been sent.*

## Pull request text

**Title:** Add the `shapi` namespace (third-party API usage in SaaSBOMs)

SHAPI exports a repository's third-party API usage as a CycloneDX 1.7 SaaSBOM (`shapi scan --sbom`):

- each provider the code calls is a `service`, with its endpoints;
- each HTTP client or SDK is a `component`, with its call sites as `evidence.occurrences`.

A few facts have no standard field, so they go in properties under `shapi:`. We'd like to register the namespace so the names are reserved and documented.

| Property | On | Value |
|---|---|---|
| `shapi:provider` | `service`, `component` | The provider's id in SHAPI's registry (`github`, `stripe`) |
| `shapi:operation` | `service` | One operation the code calls, `METHOD /path/{param}`; repeated, one per operation |
| `shapi:callSites` | `service`, `component`, `metadata` | How many call sites go to this provider, go through this client, or are in the whole BOM |
| `shapi:kind` | `component` | `http` for an HTTP client (fetch, axios), `sdk` for a provider SDK |
| `shapi:lockfileVersion` | `metadata` | The version of the `api.lock` format the BOM was made from |
| `shapi:generator` | `metadata` | The tool and version that wrote the `api.lock` |
| `shapi:unresolvedCallSites` | `metadata` | Call sites of a known provider whose endpoint couldn't be determined statically |

Each call site's id also appears in `evidence.occurrences[].additionalContext` as `shapi:callSite=<id>`, so a BOM entry can be traced to the `api.lock`.

**The namespace document** (`shapi.md` in the repository's format) would say:

- **Maintainer:** SHAPI (https://shapi.dev).
- **Purpose:** third-party HTTP API usage in a SaaSBOM: which services a codebase calls, through which clients, from which call sites.
- **The properties:** as in the table above.

**Example:** the SaaSBOM of SHAPI's demo repository, which validates against the CycloneDX 1.7 schema. The GitHub App serves it for each repository at `/sbom.cdx.json` from its dashboard page.
