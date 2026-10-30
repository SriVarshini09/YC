# PB-75: Advisories as OSV, verdicts as OpenVEX (execution plan S-03)

## Why

Security teams already run tools that read OSV records and VEX documents. If SHAPI publishes in those formats, its advisories and verdicts show up next to CVEs without anyone writing an integration.

## What changes

- **Each advisory is published as an OSV record** at `shapi.dev/osv/<id>.json`, with an index at `shapi.dev/osv/index.json` listing each record's ID, modified time and URL. Both are served to any origin, like the advisory schema.
  - **ID:** `x_SHAPI-<advisory id>`. `x_` is the prefix OSV sets aside for databases it doesn't list.
  - **No `package`.** OSV's ecosystems are package registries, and an API change has no package or version range. The API details go in `affected[].ecosystem_specific`: provider, endpoint, change class, trigger, effective date and recipe.
  - **Severity and status** (`verified` or `unverified`) go in `database_specific`.
  - **References:** the provider's notice is `ADVISORY`; the other sources are `WEB`.
  - **`modified`** is the latest date the advisory records: effective date, notice, first sighting, or a source fetched. A record changes only when its advisory does.
- **`shapi scan --vex <file>`** writes the scan's verdicts as an OpenVEX 0.2.0 document, with one statement per advisory that reaches the code:
  - **`affected`** when a call site is affected, with the migration note as the action;
  - **`not_affected`** (`vulnerable_code_not_present`) when the code only calls the changed endpoint;
  - **`under_investigation`** for "possibly affected" and "Could not tell".
  - Each call site is listed as a subcomponent: its line on GitHub at the scanned commit.
- **`advisoryToOsv` and `matchToOpenVex`** are exported from `@shapi/core`.

## Verified

- **Every advisory's record validates** against the official OSV schema (draft 2020-12, formats checked, Ajv).
- **A scan's VEX document validates** against the official OpenVEX 0.2.0 schema. The tests cover all three statements: affected, not_affected, and a GraphQL call SHAPI can't read, which becomes under_investigation.
- **The published files stay in sync:** a test regenerates them (`UPDATE_OSV=1` rewrites them) and fails on any difference.
- **CLI:** `scan --vex` writes a document with an affected statement for the demo fixture.
- **Server:** `/osv/` files are served with `access-control-allow-origin: *`.
- **Not run:** osv-scanner and vexctl themselves, since running downloaded binaries needs the founder's OK. The official schemas are what those tools validate against.

## Needs a deploy

The OSV files and the CORS header reach shapi.dev at the next deploy.
