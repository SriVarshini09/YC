# M1-T6 matcher

What exists: `matchAdvisories(lock, advisories, { now, horizonDays })` in `packages/core/src/matcher.ts`. A call site matches an advisory when provider, method (or `*`), optional host list, and endpoint pattern all match. It is **affected** when its dependency surface hits the advisory's trigger (status code compared, field read, enum compared, header or query param sent, or `any`), with a plain-words reason such as "compares the response status to 204" or "sends minorversion=65 (below 75)". A call site that calls the endpoint without depending on the change (for example it only checks `.ok`) is **exposed**. `upcoming` lists advisories for providers present in the repo (by call site or package.json) whose effective date falls within the horizon (default 90 days).
How to run: `pnpm test packages/core`.
Not done: CLI output (T1.7). Exposed call sites are counted but carry no severity.
Decisions: a call-site parameter (`{owner}`, `{}`) matches pattern parameters and wildcards but never a pattern literal, so unknown segments cannot produce false positives. Findings sort by severity, then file and line.

```
pnpm test packages/core
```
