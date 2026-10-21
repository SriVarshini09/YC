# SHAPI

Self-maintaining APIs. SHAPI maps the third-party APIs a codebase depends on (`api.lock`: every call site, and the status codes, fields, enums, headers and query params each one relies on) and flags the call sites that a known breaking change actually hits.

## Try it

Requires Node 22+ and pnpm.

```bash
pnpm install
```

```bash
npx shapi scan fixtures/demo-ts
```

The demo flags `src/deploy.ts`, which requires `res.status === 204` from GitHub's workflow_dispatch endpoint (it started answering 200), plus a QuickBooks call pinned to minor version 65 and a HubSpot v1 call with a deadline on 2026-12-04. The command exits 1 because a critical finding exists (`--fail-on none` to disable).

Other flags: `--json`, `--out api.lock`, `--repo <git url>`, `--advisories <dir>`.

## Layout

- `packages/core`: provider registry, api.lock and advisory schemas, matcher
- `packages/extractor`: TypeScript/JavaScript call-site and dependency-surface extraction (ts-morph)
- `packages/cli`: `shapi` command
- `advisories/`: seeded advisories (open JSON format)
- `fixtures/demo-ts`: demo service
- `docs/PLAN.md`: build plan; `docs/progress/`: one summary per task
- `research/`: market research and product thesis
