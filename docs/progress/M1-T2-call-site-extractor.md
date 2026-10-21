# M1-T2 call-site extractor

What exists: `packages/extractor` (`@shapi/extractor`). `extractCallSites(dir)` walks a repo (skipping node_modules, dist, dotfiles), parses TS/JS with ts-morph syntax only, and returns every call site with file:line:column, provider, client, HTTP method, host, and normalized endpoint (`/repos/{owner}/{repo}/...`).
Covers: `fetch`, node-fetch/cross-fetch, axios (verbs, config object, `axios.create({ baseURL })` instances), got, ky, undici `request`/`fetch`, ESM and CommonJS imports; URLs from literals, templates, `+` concatenation, same-file consts, `new URL()`, and `env ?? "literal"` fallbacks. SDK calls on clients built from registry packages (`new Octokit()`, `new Stripe()`, class fields, `this.x =`), mapped through the registry's SDK method table; `octokit.request("POST /route")` parsed directly. It also lists providers declared in package.json.
How to run: `pnpm test packages/extractor`.
Not done: dependency surface (T1.3); cross-file constant and client resolution; unresolvable calls are kept with `resolved: false` rather than dropped.
Decisions: no type checker (fast, works without installing the target repo's dependencies); template substitutions become `{name}` params so endpoints read like provider docs.

```
pnpm test packages/extractor
```
