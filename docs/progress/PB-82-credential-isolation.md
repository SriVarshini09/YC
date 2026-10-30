# PB-82: Sandboxes hold no credentials (execution plan I-04)

## Why

Fix jobs run a customer's untrusted code: install scripts, tests and the code under test. The worker that starts them holds every SHAPI secret: the GitHub App private key, the E2B, Anthropic and Stripe keys, and the database URL.

Nothing passed a secret into a sandbox before this change. But nothing checked either, so a future change ("forward this key for the probe") could leak one silently.

## What changes

- **`assertNoSecrets`** (`@shapi/sandbox`) runs on every sandbox command, in both the E2B and local providers. It refuses to start a process whose environment has:
  - a credential-named variable (`*key*`, `*token*`, `*secret*`, `*passw*`, `*private*`, `*credential*`, `*auth*`, `*dsn*`, `*cookie*`, `DATABASE_URL`);
  - or a value holding one of the worker's own secret values, under any name.
- **The sandbox threat model** (docs/security) records the control under T2 and closes its I-04 open item for fixes.

## What doesn't change, and why there is no proxy yet

- **The Dependabot proxy pattern** keeps provider keys in a host-side proxy, so code in a sandbox can call a provider without holding the key. No SHAPI step inside a sandbox calls a provider:
  - the network is off while repository code runs, and reaches only the npm registries during install;
  - canary probes run SHAPI's own code in the worker, not in a sandbox.

  The proxy is needed only once a sandboxed step must make a real provider call. This change makes sure no key can drift in before then.
- **The local sandbox stays development-only.** It isn't isolated from its host, and production already refuses it (`sandboxFromEnv`); in production each sandbox is its own E2B microVM.

## Verified

- **The guard:**
  - allows the sandbox's own variables (`CI`, `FORCE_COLOR`, Corepack, npm, Python);
  - refuses `GITHUB_TOKEN`, `OPENAI_API_KEY`, `STRIPE_SECRET`, `AWS_SECRET_ACCESS_KEY`, `SENTRY_DSN`, `DATABASE_URL` and `npm_config__authToken`;
  - refuses a harmless name carrying a host secret's value.
- **A sandbox process:** with fake keys in the host environment, it prints its whole environment and none of the keys appear. Handing it a key is refused.
- **The fix workspace:** with fake keys in the worker's environment, install, the TypeScript and Python contract tests, the repository's suite and the type-check all run with environments that hold no credential.
