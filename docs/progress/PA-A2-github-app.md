# PA-A2 GitHub App

What exists: the GitHub App. `packages/github-app` adds:
- app (JWT) and installation clients, plus short-lived tokens narrowed to some repos and permissions (read-only for scans)
- webhook signature checks
- the app manifest, which asks for the minimum permissions: metadata read; contents, pull requests, checks and issues write; push and pull_request events
- check-run output (neutral by default, failure if a repo opts in; annotations sent 50 at a time)
- redelivery planning.

The web process has `POST /github/webhook`. It verifies the signature on the raw body, stores each delivery once (keyed by `X-GitHub-Delivery`), queues it, and answers 202.

The worker handles:
- install, uninstall, suspend, unsuspend and rename
- repository resync, which also adds a lost install from the API
- pushes to the default branch, which queue one scan per commit.

Each delivery runs in one locked transaction that rolls back on failure. A sweeper runs every 10 minutes: it re-queues stored deliveries, asks GitHub to redeliver ones that never arrived (GitHub never retries), and prunes payloads after 14 days.

Verified: 162 tests pass, 25 of them new, against a fake GitHub and real Postgres. A local run took a signed ping through web, queue and worker, and refused a bad signature.
Not done: a live install, which needs you to register the app (below). Running the queued scans and posting check runs comes in A5, and fix PR limits in A3.

```
pnpm build
pnpm --filter @shapi/server github:register     # open the printed page; keys go to .shapi/github-app.env
pnpm --filter @shapi/server dev                 # local Postgres + web + worker + smee forwarding
```
