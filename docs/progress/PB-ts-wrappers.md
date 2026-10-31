# TypeScript: requests inside wrappers, across files

## Why

The last fixable miss on APIBreak-Replay was mindstone/mcp-servers. `bills.ts` calls `qboFetch('/bill?minorversion=65', …)`, which is imported from `client.ts`. That builds `fetch(\`${getBaseUrl()}${entityPath}\`)`, with `getBaseUrl()` and `getApiHost()` in `auth.ts`. SHAPI saw the `fetch` but never the path or query a caller passes.

## What changes (`packages/extractor/src/callsites.ts`)

- **Wrappers.** A `fetch` or axios-style request whose URL or options use its function's parameters is read once per caller: in the same file, or in a file that imports the wrapper by name from a relative module. Each read uses that caller's arguments, with defaults where an argument is missing.
  - A wrapper's call to itself (a retry) is not a caller.
  - Callers of one endpoint form one call site with every distinct query value, header and body field they send.
  - With no resolvable caller, the call stays as before.
- **Helpers.** A same-project function's return value is evaluated, local or imported from a relative module (`getBaseUrl()`, `getApiHost()`), in its own file.

## Verified

- New tests:
  - a wrapper across three files with imported helpers and a ternary host;
  - all callers current (not affected);
  - no caller (unchanged);
  - a same-named function in a file that doesn't import the wrapper (ignored).
- The mindstone files at their base and fix commits: affected before the fix, exposed after it.
- Tests: packages 583, apps 176. Build, typecheck and lint are clean.

## Not done

- Spreads in an options object (`{ ...options }`) aren't followed, so a wrapper call's method can read as GET when the caller passes POST. This can only miss a method-specific advisory, never add a false alarm.
