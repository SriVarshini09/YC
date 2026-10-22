# PA-A4 real sandbox

What exists: `packages/sandbox` puts every sandbox behind one interface.
- **E2B (production):** a Firecracker microVM per job, built from SHAPI's own template `shapi-node22` (Node 22 plus Corepack), with a hard lifetime (15 minutes by default). It is killed after use, and also when its own setup fails.
- **Local temp folder (development):** not isolated, and refused when `NODE_ENV=production`.

The flow, in the repair package's `sandboxWorkspace`:
1. Repo files go in.
2. Dependencies install with only the npm and Yarn registries reachable.
3. vitest is added if the repo has none.
4. The network is turned off entirely before any of the repository's own code or tests run.
5. `withSandboxWorkspace` always destroys the sandbox.

`repairCallSite` now works against a workspace, either that sandbox or a local copy (the CLI, unchanged). It also refuses to treat a test run that never ran tests (a startup crash, an import error) as proof that the code is broken. `fetchRepoSnapshot` downloads a repository at one commit through the tarball API, outside the sandbox, with a scoped read-only token. Only files go in (no symlinks, history or dependencies), never a credential.

Verified: 192 tests pass, 14 of them new. A live check in E2B on 2026-10-22:
- **Isolation:** the npm registry was reachable while installing; example.com and api.github.com were blocked; everything was blocked once the network was off; no keys or tokens appeared in the environment.
- **Read-only token:** it downloaded shapi-demo at the broken commit `3f8768d`, and its write attempt got 403.
- **Repair:** `npm install` ran in the microVM, the contract test failed first, the recipe made both cases pass, and the sandbox was destroyed (about 29s in total, no sandboxes left running).
- **Bugs found and fixed:** the first command ran in a folder that did not exist yet, and a sandbox leaked when setup failed. E2B's default image (Node 20.9) crashed vitest, so the template uses Node 22, and the agent now guards against crashed runs.

Not done: wiring this into the scan and fix jobs (A5), a caching registry proxy, and an E2B key on the hosted service.

```
pnpm --filter @shapi/sandbox build-template      # once per E2B account; needs E2B_API_KEY or .shapi/e2b.env
pnpm test
```
