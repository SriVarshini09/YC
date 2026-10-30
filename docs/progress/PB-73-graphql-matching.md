# PB-73: Advisories can match the GraphQL operations a call sends

## Why

Shopify's Admin API is GraphQL: one endpoint, `/admin/api/{version}/graphql.json`, and a breaking change is about a query, a mutation or a field. SHAPI saw only the endpoint, so a Shopify GraphQL advisory had to flag every GraphQL call in a repository. That's why C-06 (Shopify coverage) couldn't be done well.

## What changes

- **The extractor records each call's GraphQL document** as the request body's `query`, as a `fetch` to the endpoint already sends it:
  - SDK GraphQL clients (`client.request(document)`, `octokit.graphql`): the first argument, as a string, template, `gql` / `graphql` tagged template, or a const holding one;
  - Shopify's app templates (Remix, React Router): `admin.graphql(document)` is found as a Shopify call when the file imports from a `@shopify/` package or the app's `shopify.server`, and the argument is a GraphQL document. A `.graphql()` call anywhere else isn't treated as Shopify.
- **`graphqlSelections()`** (`packages/core/src/graphql.ts`) reads a document's operations and the dotted path of every selected field.
  - It reads past arguments, variables, directives, aliases and comments.
  - Inline fragments select into their parent; named fragments are expanded where spread.
  - A document it can't follow gives undefined.
- **A new advisory trigger, `graphql`:** a list of `{ field, operation? }`. `field` is a root field, a dotted path, or a field name at any depth.
  - A call whose document selects it is **affected** ("selects automaticDiscounts in its GraphQL query").
  - One whose document doesn't select it is **exposed**.
  - One whose document SHAPI can't read (passed in a variable, or interpolated) is **possibly affected**.
- **The advisory JSON Schema** (both copies) gains `trigger.graphql`, and `advisories/README.md` describes it.

## Verified

- **Core tests** (`packages/core/test/graphql.test.ts`):
  - the parser on aliases, arguments, directives, comments, strings with braces, mutations, the shorthand query, inline and named fragments;
  - unreadable documents give undefined;
  - field matching;
  - the trigger's affected / exposed / possible verdicts, and the `operation` filter.
- **Extractor tests** (`packages/extractor/test/graphql.test.ts`):
  - a `fetch` body;
  - `client.request` with a template const, a `gql` tag, and an unknown document;
  - a Remix `admin.graphql` call found, and a `.graphql()` call in a non-Shopify file not found.
- **End to end:** a scan with a Shopify advisory on `automaticDiscounts` marks the two calls that select it affected and the other two exposed.
- **Checks:** the extractor, core, CLI, MCP and server cloud and web tests pass from the repository root, along with typecheck and lint.

The public `shapi-advisories` mirror needs the regenerated schema after the next deploy, before any advisory there uses `graphql`.
