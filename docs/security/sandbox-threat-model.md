# Sandbox threat model

Execution plan SC-02. Status: **draft for the founder's review** (sign-off at the end). It describes the code as of `main` on 2026-10-30; file references are to this repository.

## What the sandbox is for

SHAPI's fix job proves each fix before it opens a PR: it installs the customer's dependencies, writes a contract test, runs it before and after the change, runs the repository's own tests, and type-checks. All of that executes code SHAPI didn't write and doesn't trust:

- the customer's code and tests;
- every dependency's install scripts (`preinstall`, `install`, `postinstall`);
- a fix Claude proposed (only when the account turned Claude on).

The benchmark (`bench:run -- --fix`) runs the same steps on public repositories.

Scanning is a different, smaller risk: it reads code without running it. That's covered at the end.

## Assets

| Asset | Where it lives | Who must not get it |
| --- | --- | --- |
| The customer's source code | GitHub; fetched by the worker with a read-only installation token; copied into the sandbox | Anyone but the customer and SHAPI |
| SHAPI's secrets: GitHub App private key, installation tokens, E2B and Anthropic keys, database URL, Stripe keys | The Fly worker's environment | Everything inside a sandbox |
| Provider keys a probe uses (canary) | The canary's environment, not the fix sandbox | Everything inside a sandbox |
| The integrity of a "fixed" verdict | The fix job's reading of test results | A repository or dependency that wants a bad fix to look proven |
| SHAPI's compute budget | E2B account | Runaway or hostile workloads |

## Trust boundaries and data flow

1. **The worker (trusted)** fetches a snapshot of the repository at the scanned commit through the GitHub API, with a token limited to `contents: read` and `metadata: read` on that one repository.
2. **The worker** asks E2B for a Firecracker microVM from the `shapi-node22` template (`packages/sandbox/src/template.ts`): the official Node 22 image, commands run as the unprivileged `user`.
3. **It writes the whole snapshot** into `/home/user/repo` (`sandboxWorkspace`, `packages/repair/src/workspace.ts`), after limits:
   - skipping `.git`, `node_modules`, `dist`, `coverage`, `.shapi`, `.next` and `.turbo`;
   - at most 20,000 files and 200 MB, and no single file over 5 MB except manifests and lockfiles (`packages/sandbox/src/snapshot.ts`).
4. **Install with registry-only egress.** The network is switched to `registry`: all outbound traffic denied except `registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`, and, since 2026-10-30 (approved by the founder), PyPI's `pypi.org` and `files.pythonhosted.org` (`REGISTRY_HOSTS`, `packages/sandbox/src/types.ts`). The install command:
   - npm: `npm ci` with a lockfile, or `npm install` without one;
   - Python (a `requirements.txt`, `pyproject.toml`, `setup.py` or `setup.cfg`): a virtualenv in `.shapi-venv`, then `pip install -r requirements.txt` (or `pip install -e .`), any `requirements-dev.txt`/`requirements-test.txt`, and `pytest`. A failed Python install is reported, not fatal;
   - pnpm: `pnpm install --frozen-lockfile`;
   - yarn: `yarn install --immutable`.
5. **Network off.** It is switched off entirely (`allowInternetAccess: false`) before any of the repository's own code or tests run, including after a failed install.
6. **Tests run with no network:** contract tests, the repository's tests and the type check. Output is capped at 64 KB per stream.
7. **The sandbox is destroyed** after the job, or when setup fails. Its lifetime is 15 minutes by default, extended per command up to a hard cap of 60 minutes.
8. **Claude is called by the worker, never from the sandbox.** Only the file being fixed, the call site and the advisory are sent, and only when the account opted in.

**Environment variables inside the sandbox:** `CI=1`, `FORCE_COLOR=0`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `npm_config_update_notifier=false`. No SHAPI secret, token or key is passed in, and since I-04 every sandbox command is checked: both providers refuse to start a process whose environment has a credential-named variable (`*KEY*`, `*TOKEN*`, `*SECRET*`, `DATABASE_URL` and the like) or a value holding one of the worker's secrets (`assertNoSecrets` in `@shapi/sandbox`).

## Threats

| # | Threat | Today's control | Residual risk | Recommendation |
| --- | --- | --- | --- | --- |
| T1 | **Sandbox escape**: code breaks out of the microVM to the host or other tenants | Firecracker microVM per job (E2B), unprivileged user, short lifetime, destroyed after use | Depends on E2B and Firecracker; a VM escape is a vendor-level vulnerability | Keep E2B current; record E2B's SOC 2 and isolation statements in the vendor list (SC-03) |
| T2 | **Secret theft** from inside the sandbox | No secret enters the sandbox: tokens and keys stay in the worker; the snapshot is fetched by the worker; Claude is called by the worker; every sandbox command's environment is checked for credentials (I-04), with tests that a sandbox process sees none of the host's keys and that no fix step passes one | Secrets that live in the customer's own repository (a committed `.env`) are copied in with the code | Skip `.env*` and other secret-shaped files from snapshots unless a test needs them; document this for customers |
| T3 | **Install-time exfiltration of the customer's code** (install-time egress, postinstall scripts): a malicious or compromised dependency's `postinstall` (or a Python package's setup script) runs while the network is open to the npm registries and PyPI, with the whole repository already written | Egress limited to the npm, Yarn and PyPI registry hosts; lockfile-pinned installs where a lockfile exists; network off before any of the customer's code runs | **High.** The registry is a write-capable service: a script with an attacker's npm token embedded can `npm publish` the source to a package, or encode it in request paths to the allowed hosts. Without a lockfile, `npm install` resolves the newest versions, which widens the window. | **Install from the manifests alone:** write only `package.json` files and lockfiles first, install, cut the network, then write the rest of the snapshot. A postinstall script then sees no source code. A second step: `--ignore-scripts` where the project's tests pass without them. Both are small changes in `sandboxWorkspace` |
| T4 | **DNS exfiltration**: data encoded in DNS lookups (`<data>.attacker.example`) while egress is "registry only" | Allowlisting is by hostname, enforced by E2B's network rules | **To verify:** whether E2B resolves DNS for denied names. If lookups for any name leave the VM, they are a slow but working channel during install (T3). With the network off, no lookup should leave the VM; also to verify. | Verify with a test sandbox: resolve an attacker-style name in `registry` mode and in `off` mode, and record the result here. If lookups leak, apply T3's manifests-only install, which removes the data the channel would carry |
| T5 | **Dependency confusion and typosquatting** during install | Lockfile-pinned installs; only public registries reachable, so private registries a repository expects are unreachable and the install fails rather than falling back | Repositories without a lockfile get the newest versions from the public registry | Treat "no lockfile" as a lower confidence tier for the fix; say so in the PR |
| T6 | **A false "fixed" verdict**: the repository or a dependency makes SHAPI's contract test pass without the fix working (a setup file that mocks `fetch`, a vitest plugin, a patched test runner) | SHAPI writes its own vitest config but keeps the repository's setup files and plugins (`shapiVitestConfig`); the undo check (V-04) requires each part of the fix to make the test fail when undone; the scope check (V-05); the keep check (V-06); the PR still needs a human merge | A repository that intentionally sabotages SHAPI's tests can make a fix look proven to itself | Acceptable: the only victim is the repository doing it, and the PR is still reviewed. Note it in the security page |
| T7 | **Path traversal and injection** in what SHAPI writes or runs | Every path goes through `safeRelative` (no `..`, no absolute paths, no drive letters); commands are argument arrays, each shell-quoted (`shellQuote`) | Low | None |
| T8 | **Resource abuse**: a fork bomb, a hung test, gigabytes of output | Per-command timeouts; a 15-minute default and 60-minute hard lifetime; output capped at 64 KB per stream; snapshot size limits; the I-02 job time limits and dead-letter queue | A heavy test suite costs E2B minutes, up to the cap, per fix | Watch E2B spend per account; the hourly PR limit bounds fix jobs per repository |
| T9 | **Network attacks from the sandbox** while tests run: scanning internal networks, calling cloud metadata endpoints | Network off for every step after install | None while off; during install only the registry hosts are reachable | None |
| T10 | **Cross-tenant leakage** through a reused sandbox | A new sandbox per fix job; destroyed afterwards; not reused across repositories or accounts | Low | None |
| T11 | **The local provider in production**: running repositories on the worker itself | `sandboxFromEnv` refuses the local provider when `NODE_ENV=production`; the local provider is for SHAPI's own fixtures and tests | None in production | None |

## Scanning (static analysis)

The scan job reads code without running it. The parser runs in a separate child process with time and memory limits (I-01, `apps/server/bin/scan-child.mjs`), so a pathological file can't take down the worker. Nothing from the repository is executed, installed or imported. The residual risk is a parser bug, which the process limits contain.

## Open items

1. **T3, manifests-only install.** Recommended next change, small and contained in `sandboxWorkspace`.
2. **T4, DNS behavior.** Verify with E2B in `registry` and `off` modes and record it here.
3. **T2, secret-shaped files.** Leave `.env*` out of snapshots, behind a setting for repositories whose tests need them.
4. **I-04, credential isolation.** Done for fixes: sandbox commands are checked, and the network is off while repository code runs, so nothing in a sandbox can call a provider with or without a key. A proxy that adds provider keys on the host side (the Dependabot pattern) is only needed once a step inside a sandbox must call a provider for real, which none does today; canary probes run SHAPI's own code in the worker.

## Review

- [ ] Reviewed by the founder. Date: ____. Decisions on the open items: ____.
