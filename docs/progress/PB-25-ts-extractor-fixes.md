# PB-25 TypeScript extractor fixes: call sites the extractor missed or recorded wrongly

These come from the full review on 2026-10-29 (review 3, section B: TS/JS extraction, false negatives). Each finding was reproduced with a failing test first. The tests are in `packages/extractor/test/ts-shapes.test.ts`.

## Why

The TypeScript and JavaScript extractor missed common code shapes, so advisories that should have fired never did. Examples: a Zendesk URL with a runtime subdomain, an axios instance on a class member, an OpenAI client exported from `lib/openai.ts`, and a `fetch().then(r => r.json()).then(d => …)` chain. Large generated files also took quadratic time to scan.

## What changes

- **Hosts built at runtime (B1):** `parseUrl` keeps a templated host as `runtimeHost` (`host` stays null). `providerOf` resolves the provider from the host's fixed suffix on a `*.` provider host: `{sub}.zendesk.com`, `{dc}.api.mailchimp.com`, `{shop}.myshopify.com`, `{site}.atlassian.net`, `*.salesforce.com`, `*.force.com`, `*.twilio.com` and `*.googleapis.com`. A path signature whose version segment is a runtime value also names its provider (`/admin/api/{ver}/script_tags.json` is Shopify), so `shopify-script-tags-stop-running` now fires on it.
- **Class members (B2):** `this.http.get(...)` and `this.http(...)` on an `axios.create`/`got.extend`/`ky.create` instance are matched. The instance was already collected but never looked up.
- **Instance headers and query (B3):** the instance keeps its `headers` and its `params` (axios) or `searchParams` (got, ky), and every call records them. When a call sets the same header or query name, the call's value wins. `anthropic-api-version-2026-10-21-sampling-params-400` now fires on an instance that pins `anthropic-version`.
- **Promise chains (B4):** a `.then` callback's return value, from an expression body or a `return`, flows to the `.then(...)` call's result. So `.then(r => r.json()).then(d => d.x)` and `await fetch(u).then(r => r.json())` record the body's fields, enums and statuses.
- **Clients from another file (B5):** a relative import of an SDK client (`import { openai } from "./lib/openai"`, `.js` specifiers for `.ts` files, `./lib` for `lib/index.ts`) is followed to the file that constructs it. This works through `export const`, `export default`, `export { x as y }`, `export { x } from`, `export * from` and imported-then-re-exported names. The client's constructor options (`apiVersion`, `defaultHeaders`) are read in that file. `extractCallSites` now adds every source file to the project before extracting. Not covered: tsconfig path aliases (`@/lib/openai`), CommonJS `module.exports`, and HTTP instances exported from another file.
- **Other import forms (B6):** `import X = require("m")`, `require("m").default`, and undici's module object (`const undici = require("undici"); undici.request(...)`).
- **`new URL(path, base)` (B7):** resolved the way `URL` does. An absolute path replaces the base path, a relative path replaces the base's last segment, and `.`/`..` are resolved. `new URL("/v21.0/me", "https://graph.facebook.com/v20.0/")` is `/v21.0/me`, not `/v20.0/v21.0/me`.
- **`parseUrl` (B8):** userinfo (`user:pw@`) and the port are no longer part of the host. Query names and values are decoded (`%2C` becomes `,`, `+` becomes a space). A malformed escape is kept as written.
- **SDK host (B9):** SDK call sites of a provider with a `*.` host (Shopify, Salesforce, Zendesk, Mailchimp, Atlassian, Twilio, Google) get host `null`. Before, Shopify SDK sites got `discover.shopifyapps.com` and Twilio got `api.twilio.com`. No advisory restricts hosts for these providers.
- **Linear-time scans (B10):** line and column come from a per-file line table. ts-morph's `getLineAndColumnAtPos` scans the text from the start on every call. The loose-URL pass checks "inside a found call" by walking ancestors, and finds base URLs by binary search over sorted paths. Same-name consts are collected without copying arrays. A file with 12,000 fetches and 12,000 URLs now takes under 1 s; before, it took 20.6 s.
- **Bundles not scanned (B10):** `public/` joins the skipped folders (`node_modules`, `dist`, `build`, …), and `*.min.js` and `*.bundle.js` files (also `.mjs`/`.cjs`) are skipped.
- **Docs:** `site/guide/how-it-works.md` describes instance headers, `this.http`, clients imported from another file, runtime subdomains and versions, and the skipped folders and bundles.

`fixtures/demo-ts/api.lock` did not change.

## Verified

- `packages/extractor/test/ts-shapes.test.ts` has one test or more per finding. Each failed before the fix. The B10 timing test took 20.6 s before the fix (limit 10 s), and 0.9 s after.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
