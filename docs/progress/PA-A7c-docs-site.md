# PA-A7c docs site

What exists: a VitePress site in `site/`, published to **https://srivarshini09.github.io/YC/** by `.github/workflows/docs.yml` once Pages is enabled.

Pages, each written from the code rather than from plans:
- Home, Quickstart and the CLI reference (every `scan` and `fix` option, exit codes, environment variables)
- How it works (map, match, fix, watch) and How fixes are verified (contract test, recipe vs Claude, where the test runs)
- Advisories (format, key fields, how to contribute to `shapi-advisories`)
- GitHub App (marked early access: permissions, noise controls, the web app, plans with pricing not yet announced)
- Coding agents (the four MCP tools and setup from a clone)
- Security and code handling (CLI behavior, tokens, the E2B sandbox, what is stored and for how long, row-level security, Claude opt-in, reporting a vulnerability) and FAQ

Wiring:
- `site` is a workspace package (`@shapi/site`). Its scripts are `docs:dev`, `docs:build` and `docs:preview`, so `pnpm -r build` (install, Docker) does not build the docs.
- The Docker image copies `site/package.json` so the frozen lockfile still matches.
- The workflow builds on pull requests that touch `site/` (VitePress fails on dead links) and deploys on pushes to main.
- The root README and the npm README link to the site; the npm one updates with the next publish.

Verified:
- `pnpm --filter @shapi/site docs:build` passes with no dead links.
- Home, Quickstart and Security checked in a browser (dark theme, teal accent).
- `pnpm lint` and `pnpm typecheck` pass.

Needs you: Settings → Pages → Source: **GitHub Actions**. The first deploy runs after merge.

Not done: private vulnerability reporting, which the Security page points to, still has to be turned on in the repository settings.

```
pnpm --filter @shapi/site docs:dev
```
