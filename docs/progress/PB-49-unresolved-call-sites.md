# PB-49: SHAPI says when it cannot tell (execution plan A-03)

## Why

A call site whose URL SHAPI could not place dropped out of matching silently, so a repository could look clear when SHAPI simply didn't know. Two cases from a probe:

- `` fetch(`https://api.github.com${path}`) `` lost its provider entirely. The URL parser read `api.github.com{path}` as one runtime host, and the endpoint came out as `/`.
- `` fetch(`https://graph.facebook.com/${path}`) `` became `/{path}`. That could be any Graph endpoint, including a retired version, yet it matched nothing and showed as clear.

Admitting "unresolved" is more credible than guessing.

## What changes

- **Glued hosts.** The URL parser splits a known host written straight before a runtime path (`api.github.com${path}`) into the host and `/{path}`, so the provider is kept.
- **`pathUnresolved()` in `@shapi/core`.** A path is unresolved when there is none, or when every segment is built at runtime (`/{path}`, `/{a}/{b}`). The root `/` and partly known paths (`/v21.0/{path}`, `/{page_id}/feed`) are resolved. The extractor's `resolved` flag now uses it for HTTP call sites (TypeScript and Python).
- **Matcher.** `matchAdvisories()` returns a new `unresolved` list: call sites of a known provider with an unresolved path, while that provider has advisories. Each appears once, with the reason and the advisories its method and host could reach. They are never matched by a guess: not affected, possible or exposed.
- **Output:**
  - the CLI prints "Could not tell, check these by hand (N)";
  - `--json` and the MCP `scan` tool include them (`unresolved` and `unresolvedCallSites`);
  - the GitHub check has a "Could not tell" section that says SHAPI doesn't count them as clear.
- **Not covered.** A URL with no provider at all (`fetch(buildUrl(path))`) is still not listed: nothing ties it to an API.

## Verified

- **Tests:**
  - `pathUnresolved()`: null and fully runtime paths are unresolved; `/`, `/v21.0/{path}` and `/{page_id}/feed` are not.
  - The GitHub call keeps its provider and host. Both runtime-built calls are unresolved, not affected, possible or exposed.
  - Each lists only its own provider's advisories, including `github-workflow-dispatch-204-to-200` and `meta-graph-v21-sunset`.
  - The pinned `/v21.0/{path}` call is still affected by the v21.0 sunset. The no-provider call isn't listed.
  - The check run shows "Could not tell" and drops the "checked every call site" line.
- **Benchmark gate:** passes with the matcher change.
- **Full suite:** typecheck, lint and the full test suite.
