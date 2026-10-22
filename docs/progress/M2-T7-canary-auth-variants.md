# M2-T7 canary: separate token and anonymous observations

What exists: every probe now declares `auth: "anonymous" | "token"` and stores its shapes under its own source (`canary:github:anonymous`, `canary:github:token`, `canary:stripe:token`). The scheduler compares a response only with earlier ones from the same source. `ShapeStore.history`, `latest` and `previousDistinct` take an optional source (history now takes `{ limit, source }`), `endpoints()` and `pnpm canary status` list one row per endpoint and source, and replay compares within source `replay`. Shape inference also ignores transport headers (`transfer-encoding`, `accept-ranges`, `content-encoding`, `vary`, `alt-svc`, `cache-control`) and GitHub's token-expiration header.
Why: the first run with `SHAPI_GITHUB_TOKEN` set compared signed-in responses with earlier anonymous ones. GitHub adds `permissions` and drops `temp_clone_token` for signed-in callers, so the canary reported a breaking field removal on `/repos/{owner}/{repo}` and wrote a false draft advisory, now deleted.
How to run: `pnpm canary run --once` (with or without the GitHub variables); `pnpm canary status`.
Not done: observations already in a local `.shapi/shapes.db` keep the old source `canary:github`, so the first run after this change reports every probe as "first".
Decisions: a regression test runs the same endpoints anonymously, then with a token, then anonymously again, and expects no change and no draft. Live check: two anonymous runs against GitHub, the second reported "same" for all 4 probes.

```
pnpm canary run --once
pnpm canary status
```
