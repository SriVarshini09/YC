# Reliable, Low-Noise Automated PR Delivery at Scale (GitHub App first, GitLab/Bitbucket later): lessons from Renovate, Dependabot, Moderne

Research date: 2026-10-22. Scope: architecture and practices for SHAPI's fix-PR delivery (codemod + generated contract test + evidence block), moving from a user token via Octokit's Git data API to a GitHub App.

## 1. GitHub App building blocks: framework choice, permissions, tokens, webhook reliability, rate limits, Marketplace

### Takeaway
Use a GitHub App (not a user token), hand-rolled on `@octokit/app` / `@octokit/webhooks` (or Probot v14 if you want batteries), with the webhook handler doing only verify, enqueue, and return 2xx inside 10 s; all PR work runs from a durable queue, serialized per installation, with at least 1 s between writes and built-in handling of secondary rate limits. GitHub never auto-retries failed webhooks, so a scheduled redelivery sweeper plus idempotency keys (`X-GitHub-Delivery` plus a deterministic content key) are mandatory. Check runs, which carry the strongest signal for findings, can only be created by a GitHub App, which is a second reason to move off the user token.

### Cited Findings

**Framework: Probot vs Octokit directly**
- Probot v14.0.0 is ESM-only. It dropped Node 21 and older Node 20 releases, moved webhook types to GitHub's OpenAPI spec (away from `@octokit/webhooks` v13), removed legacy REST endpoint methods in favor of `octokit.rest.*`, removed the built-in Express server, made `createNodeMiddleware()` async, and now binds to localhost by default — [JSR @probot/bot](https://jsr.io/@probot/bot@14.0.0/doc); [openapps.pro Probot listing](https://openapps.pro/packages/probot)
- The latest Probot found is 14.3.2 (release date unconfirmed). No 2026 deprecation or maintenance announcement was found — [JSR diff 14.3.2](https://jsr.io/@probot/bot/diff/14.3.2...14.3.1)
- The Octokit SDKs generate installation tokens for you and regenerate them after they expire — [GitHub Docs: installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

**Installation tokens**
- An installation token is created with `POST /app/installations/{installation_id}/access_tokens`, using an app JWT as a Bearer token. It "will expire after 1 hour" — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- Tokens can be down-scoped. `repositories` or `repository_ids` accept up to 500 repos, and a `permissions` body param narrows permissions. A token can never exceed the installation's repo access or the app's granted permissions — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- **Breaking change to watch:** starting April 27, 2026, new installation tokens may use a stateless `ghs_APPID_JWT` format instead of exactly 40 characters. Apps that assume a 40-char length (DB columns, regex validation, secret scanners) may fail. The docs' example uses API version header `X-GitHub-Api-Version: 2026-03-10` — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- Installation IDs come in webhook payloads or from `GET /repos/{owner}/{repo}/installation` — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

**Permissions**
- GitHub Apps start with no permissions, and should request only what they need. Changing permissions takes effect per installation only after the account owner approves. Until then the installation keeps its old permissions — [GitHub Docs: choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- HTTP-based Git access (clone/push) needs the "Contents" repository permission. Editing files under `.github/workflows` needs the separate "Workflows" permission — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- A 403 caused by insufficient permissions returns an `X-Accepted-GitHub-Permissions` header naming what is required. GraphQL returns 401 instead — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- Webhook events whose required permissions the app lacks don't appear as subscription options — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- Only GitHub Apps can create check runs. "OAuth apps and authenticated users can view check runs and check suites, but they are not able to create them." PATs (classic) also can't update check runs — [GitHub Docs: Check runs](https://docs.github.com/en/rest/checks/runs)

**Webhook delivery reliability**
- Respond with 2xx within 10 seconds, or GitHub drops the connection and marks the delivery failed. Ack immediately and process asynchronously via a queue (the docs suggest Hookdeck, Resque, RQ, RabbitMQ) — [GitHub Docs: webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- "GitHub does not automatically redeliver failed deliveries." The recommended pattern is a scheduled script that lists the app's webhook deliveries since the last run ("List deliveries for an app webhook"), picks those with `status` other than "OK", and calls "Redeliver a delivery for an app webhook". There are no redelivery endpoints for Marketplace or Sponsors webhooks — [GitHub Docs: handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- `X-GitHub-Delivery` is unique per delivery, but a redelivery carries the *same* value as the original. Use it as a dedupe key, and it also guards against replay — [GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- Other practices from the docs: use a high-entropy secret for signature verification, use HTTPS with SSL verification on, subscribe only to the events you need, optionally allow-list IPs from `GET /meta` (and refresh it), and check `X-GitHub-Event` plus the `action` field before processing — [GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- The best-practices page says nothing about ordering guarantees or how long deliveries stay retained for redelivery — [GitHub Docs](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

**Rate limits (REST)**
- **Installation tokens, primary limit:** 5,000/hr base. Installations in a GitHub Enterprise Cloud org get 15,000/hr. Otherwise the limit grows by 50/hr per repo beyond 20 and 50/hr per org user beyond 20, capped at 12,500/hr. Rate limits are per installation, so one noisy customer can't exhaust another's budget — [GitHub Docs: rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- User access tokens share the user's 5,000/hr budget (15,000/hr for Enterprise Cloud) across all apps and PATs for that user. This is why SHAPI's current user-token approach scales poorly — [GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- **Secondary limits:**
  - 100 concurrent requests, shared between REST and GraphQL
  - 900 points/min for REST, 2,000 points/min for GraphQL
  - 90 s of CPU per 60 s of wall clock, with at most 60 s from GraphQL
  - **Content creation: generally 80/min and 500/hr**, with some endpoints stricter. Web UI actions count too.
  - 2,000 OAuth token requests/hr

  — [GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- **Point costs:** REST GET/HEAD/OPTIONS cost 1 point, and POST/PATCH/PUT/DELETE cost 5. GraphQL queries cost 1, mutations 5. Some REST endpoints have undisclosed costs — [GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- **When rate limited:**
  - Primary limit: 403/429 with `x-ratelimit-remaining: 0`. Wait until `x-ratelimit-reset` (UTC epoch).
  - Secondary limit: obey `retry-after` if present, otherwise wait at least 1 minute, then back off exponentially and give up after N tries.
  - "Continuing to send requests while rate limited can get your integration banned."

  — [GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- **Best practices:**
  - Prefer webhooks over polling.
  - Make requests serially, through a queue.
  - For mutative requests, "wait at least one second between each request."
  - Use conditional requests (`etag` / `if-none-match`). An authenticated 304 doesn't count against the primary limit.
  - Don't ignore repeated 422 validation errors, which can get the app suspended for abuse.
  - Follow redirects and use Link headers for pagination.

  — [GitHub Docs: REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)

**Marketplace listing**
- **All listings:** accept the Marketplace Developer Agreement. Only org owners can submit org-owned apps (the "GitHub App manager" role is not enough). Provide valid contact info, a privacy policy link, and a working support link or email. The app must be publicly available (not invite-only or in preview), must "provide value beyond authentication", and needs a logo, feature card, and screenshots — [GitHub Docs: Marketplace requirements](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app)
- **Paid listings:**
  - The owning org must be a verified publisher.
  - GitHub Apps need at least **100 installations** (OAuth apps need 200 users).
  - The app must handle `marketplace_purchase` events for new purchases, upgrades, downgrades, cancellations, and free trials.
  - It must support both monthly and annual billing.
  - The listing must be verified before publishing.

  — [GitHub Docs](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app)
- Free listings have no extra requirements. However, if you sell a paid version off-Marketplace and the app meets the paid requirements, you must offer at least one paid plan on Marketplace — [GitHub Docs](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app)

### Inferences
- **Recommended minimal permission set for SHAPI v1.** These are standard GitHub App permission names. Verify each against the REST endpoint reference using `X-Accepted-GitHub-Permissions` during development.
  - Metadata: read
  - Contents: read & write (clone, read files, create branches and commits)
  - Pull requests: read & write
  - Checks: read & write (findings surface)
  - Issues: write, only if SHAPI ships a Renovate-style dashboard issue
  - Workflows: write, only if codemods ever touch `.github/workflows`. Default it off; it is a high-trust ask that slows security review.
- **Webhook subscriptions:**
  - `push` on the default branch triggers a re-scan.
  - `pull_request` events (closed, merged, edited, synchronize) drive PR lifecycle state.
  - `installation` / `installation_repositories` drive onboarding and offboarding.
  - `check_run.requested_action` handles button clicks.
  - `issue_comment` handles `/shapi` commands.
- **Pipeline shape:**
  - Ingress: verify the HMAC signature, insert `(delivery_id, event, payload)` into Postgres or a queue with a unique constraint on `delivery_id`, and return 202.
  - Workers pull jobs keyed by `installation_id:repo`, run at most one job per repo at a time, and use a token-bucket limiter per installation. Target well under 80 writes/min and 500/hr per installation, and space writes at least 1 s apart.
  - A cron sweeper calls list-deliveries / redeliver every few minutes.
  - A separate "advisory published" producer fans out to the installations whose dependency index matches. This is the event-driven model Nesbitt argues Dependabot lacks (see section 3).
- **Idempotency beyond the delivery ID.** Pushes and advisory fan-outs can both trigger the same fix. Key PR work on `(repo, advisory_id, target_branch)`, and name the branch deterministically, e.g. `shapi/<advisory-id>`, so a rerun finds and updates the existing PR instead of opening a duplicate. Embed a hidden machine-readable HTML comment (advisory ID, codemod version, base SHA) in the PR body so state can be rebuilt from GitHub alone (Nesbitt makes the same suggestion; see section 3).
- **Fewest writes per PR.** Creating a PR through the Git data API costs several 5-point writes (blob(s), tree, commit, ref, pull). Batching all file changes into one tree and one commit keeps a PR to a handful of writes. At 500 content-creating requests per hour per installation, the PR count per installation per hour is bounded well before primary limits matter. Hence also limit PRs per hour, as Renovate does.
- **Token-format change.** Audit SHAPI's code for 40-char token assumptions before relying on new-format tokens (from April 27, 2026).
- **Marketplace sequencing.** List free first, since paid listing needs 100 installs plus verified-publisher status. Bill off-Marketplace (Stripe) until then, and plan to add a Marketplace paid plan once the thresholds are met.

### Gaps
- Exact per-endpoint permission names for contents, pulls, and checks were not fetched from the per-endpoint "permissions required for GitHub Apps" reference. The page fetched doesn't list them. They need verifying.
- The webhook delivery retention window for redelivery was not documented on the pages fetched. Commonly cited as about 3 days, but unverified here.
- No authoritative 2026 statement on Probot's maintenance cadence was found. The latest version found is 14.3.2, date unknown.
- The JWT max lifetime (commonly 10 minutes) was not on the fetched page.

## 2. How Renovate and Dependabot architect updates and control noise (scheduling, grouping, PR limits, dashboards, rebasing, automerge, merge confidence, monorepos, presets); why Renovate won adoption

### Takeaway
Both tools layer noise controls:
- **Rate:** concurrent and hourly PR caps.
- **Timing:** schedules and cooldown or minimum release age.
- **Bundling:** groups.
- **Gating:** approval through a dashboard.
- **Trust:** automerge, plus merge-confidence data from a crowd of installs.

Security fixes always bypass the rate and timing limits. Renovate adds a single "dashboard issue" as the control plane, which lets it keep defaults conservative without hiding work.

### Cited Findings

**Renovate limits and defaults**
- `prConcurrentLimit` defaults to 10 (max open branches/PRs per repo, 0 = unlimited). `prHourlyLimit` defaults to 2 (PR creations per hour per repo). `branchConcurrentLimit` defaults to null, meaning it inherits `prConcurrentLimit`. `commitHourlyLimit` defaults to 0 (unlimited) and covers branch creation and rebases, though manual rebases bypass it — [Renovate config options](https://docs.renovatebot.com/configuration-options/)
- `prCreation` defaults to `immediate`. Options:
  - `not-pending`: wait for checks to finish, falling back after `prNotPendingHours`, default 25
  - `status-success`: open the PR only after tests pass on the branch
  - `approval`: the branch is created but the PR waits for dashboard approval

  — [Renovate config options](https://docs.renovatebot.com/configuration-options/)
- `rebaseWhen` defaults to `auto`. Values are `auto`, `never`, `conflicted`, `behind-base-branch`, and `automerging` (behind-base-branch if automerge is on, else never). `recreateWhen` defaults to `auto` (recreate only "immortal" PRs). `stopUpdatingLabel` defaults to `stop-updating` (a human applies it to stop the bot touching the PR). `updateNotScheduled` defaults to true (keep existing PRs fresh outside the schedule). `separateMajorMinor` defaults to true. `suppressNotifications` lets you mute categories such as `prEditedNotification` and `onboardingClose` — [Renovate config options](https://docs.renovatebot.com/configuration-options/)
- `schedule` defaults to `["at any time"]` and takes 5-part cron. Minutes must be `*`, since the granularity is at least 1 hour. The timezone defaults to UTC — [Renovate config options](https://docs.renovatebot.com/configuration-options/); [Renovate noise reduction](https://docs.renovatebot.com/noise-reduction/)
- **Security PRs bypass the limits.** Renovate "always tries to create a `vulnerabilityAlerts` PR", ignoring `branchConcurrentLimit`, `commitHourlyLimit`, `prConcurrentLimit`, `prHourlyLimit`, and `schedule`. Inside `vulnerabilityAlerts` the defaults are `prCreation: immediate`, `minimumReleaseAge: null`, and `prConcurrentLimit: 0`. The hourly limits and schedule cannot be re-imposed — [Renovate config options](https://docs.renovatebot.com/configuration-options/)
- `osvVulnerabilityAlerts` (default false, experimental, direct dependencies only) pulls alerts from osv.dev — [Renovate config options](https://docs.renovatebot.com/configuration-options/)
- **Automerge:**
  - `automerge` defaults to false. `automergeType` defaults to `pr`; other values are `branch` and `pr-comment`.
  - `platformAutomerge` defaults to true, which uses GitHub/GitLab native auto-merge.
  - `automergeSchedule` defaults to `["at any time"]`.
  - Branch automerge creates a branch with no PR, pushes it to base if tests pass, and opens a PR only on failure. This is the lowest-noise mode.

  — [Renovate config options](https://docs.renovatebot.com/configuration-options/); [noise reduction](https://docs.renovatebot.com/noise-reduction/)
- **Renovate's noise-reduction guidance:**
  - Group related packages with `packageRules` plus `groupName`. The `:app` and `:library` presets include `group:monorepos`. Grouping cuts the number of PRs and lockfile conflicts but "increases the chance that the branch has an error."
  - Automerge "any type of dependency update where you would select Merge anyway."
  - Running less often *increases* concurrent PRs and lockfile conflicts.

  — [Renovate noise reduction](https://docs.renovatebot.com/noise-reduction/)
- The Mend-hosted app refreshes its queue hourly for Enterprise users and every 4 hours for Community users — [Renovate noise reduction](https://docs.renovatebot.com/noise-reduction/)

**Dependency Dashboard**
- The dashboard is a single issue Renovate maintains, showing the status of all updates. It lists deprecated dependencies, closed or ignored updates (tick a checkbox to get a PR again), and pending updates. Enable it with `:dependencyDashboard` or `dependencyDashboard: true` — [Renovate dashboard docs](https://docs.renovatebot.com/key-concepts/dashboard/)
- `dependencyDashboardApproval` can be global (discouraged, since someone must check the dashboard), major-only, or per-package. Vulnerability PRs are still created immediately. The docs recommend approval over disabling majors because pending updates stay visible. The platform must support issues with dynamic Markdown checkboxes — [Renovate dashboard docs](https://docs.renovatebot.com/key-concepts/dashboard/)

**Merge Confidence (Mend)**
- Merge Confidence "finds and flags undeclared breaking releases" using data from Mend Renovate App PRs on github.com since 2017. It shows four badges:
  - Age
  - Adoption (% of Renovate users on the release)
  - Passing (% of updates with passing tests)
  - Confidence: Low, Neutral, High, or Very High

  The algorithm is private. npm releases must be at least 3 days old to reach High. Adoption and Passing are weighted toward orgs, private repos, and high-test-reliability projects — [Renovate merge confidence](https://docs.renovatebot.com/merge-confidence/)
- Merge Confidence covers go, npm, maven, pypi, nuget, packagist, and rubygems. The badges are automatic on the Mend app and available self-hosted via `extends: ["mergeConfidence:all-badges"]`. "Merge Confidence Workflows" (e.g. only raise PRs at High confidence) need a paid Mend subscription or Mend Renovate Community (OSS) Cloud — [Renovate merge confidence](https://docs.renovatebot.com/merge-confidence/)

**Dependabot noise controls**
- `open-pull-requests-limit` for version updates defaults to 5. Security update PRs have a separate fixed limit of 10 that can't be configured. Setting the value to 0 disables version updates for that ecosystem — [Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- **Default cooldown:** Dependabot applies a 3-day cooldown to version updates (not security updates), configurable with `default-days` and `semver-major-days` / `-minor-days` / `-patch-days`. `include` and `exclude` lists take up to 150 items each, and exclude wins — [Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- **Groups:**
  - Selectors are `patterns`, `exclude-patterns`, `dependency-type`, and `update-types`.
  - `applies-to` can be `version-updates` (the default) or `security-updates`.
  - The first matching group wins. Without groups, Dependabot opens one PR per dependency.
  - `group-by: dependency-name` merges updates for a dependency across directories (single ecosystem).
  - `multi-ecosystem-groups` combine ecosystems into one PR, each with its own schedule.

  — [Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)
- **Monorepos and schedules:** `directories` supports globs for monorepos. `schedule.interval` can be daily, weekly, monthly, quarterly, semiannually, yearly, or cron. Commit messages follow the repository's detected conventions by default (prefix up to 50 characters). The default labels are `dependencies` plus the ecosystem — [Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)

**Why Renovate won adoption (architecture and licensing)**
- Renovate's CLI is AGPL, stateless, and exits after each run. The scheduler, webhook handling, and priority queueing are in Mend's closed Community and Enterprise editions, which *are* self-hostable with license keys. GitHub's equivalent coordination layer for Dependabot is not available at all — [Nesbitt, "How Dependabot actually works" (Jan 2026)](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- Renovate's platform layer spans many SCMs. For example, `stopUpdatingLabel` support lists azure, forgejo, gerrit, gitea, github, and gitlab — [Renovate config options](https://docs.renovatebot.com/configuration-options/)

### Inferences
- **SHAPI's noise model should copy the security-update carve-out, scaled to SHAPI's own risk.**
  - Advisories with a hard deadline (sunset or removal within N days, or already breaking) bypass the hourly and concurrent caps, as Renovate's `vulnerabilityAlerts` and Dependabot's separate limit of 10 do.
  - Informational or deprecation-only advisories go through a schedule, an hourly cap (Renovate's default of 2/hr/repo is a sensible starting point), a concurrent cap (5–10), and optionally dashboard approval.
- **Grouping by advisory.** One PR per (repo, provider, advisory) is the natural unit. Offer a group mode that bundles all advisories for one provider (e.g., "Stripe API 2026-xx migration") into one PR, the way Renovate groups monorepo packages.
- **A SHAPI equivalent of merge confidence.** Aggregate fix outcomes across all installs: % of SHAPI PRs for this advisory+codemod merged unmodified, % whose CI passed, and age of the codemod. Show these as badges in the evidence block. Like Mend's, this becomes a data moat that grows with install count. Gate automerge on "high confidence" plus the contract test passing.
- **Lifecycle rules to adopt:**
  - `rebaseWhen=conflicted` by default (cheapest on writes)
  - a `stop-updating` label and respect for human commits (Moderne makes the same point; see section 4)
  - on push to base, re-run the codemod and either update the PR, close it as "no longer needed", or supersede it (Dependabot's four close reasons)
  - `prCreation=status-success` as an option, so customers never see a red SHAPI PR
- **Ship a dashboard issue (or a Checks/app page) as SHAPI's control plane** rather than many comments. It lets defaults stay conservative while keeping every pending fix visible and one click away.

### Gaps
- Renovate's market-share and adoption metrics (installs, % of GitHub repos) were not found in this pass. "Why Renovate won" rests on architecture and licensing evidence, not usage data.
- Dependabot `rebase-strategy` defaults and `@dependabot` comment commands were not in the fetched portion of the options reference.
- `minimumReleaseAge` default and `matchConfidence` syntax were not captured.

## 3. Dependabot internals (dependabot-core, update jobs), security vs version updates, and how GitHub handles noise

### Takeaway
Dependabot is a stateless open-source engine (dependabot-core, MIT since May 2024) driven by self-contained JSON job definitions. GitHub's closed coordinator owns scheduling, PR state, rate limiting, and advisory matching. Jobs now run on GitHub Actions runners. SHAPI should mirror this split: a stateless "fix engine" job (codemod + contract test + evidence) and a stateful coordinator.

### Cited Findings
- **dependabot-core design:**
  - Each ecosystem implements FileFetcher, FileParser, UpdateChecker, and FileUpdater.
  - Updates shell out to native package-manager tooling.
  - The core is "a stateless Ruby library that knows nothing between runs."
  - It outputs instructions and never pushes commits itself; GitHub performs the git operations through its API.
  - It was relicensed to MIT in May 2024.

  — [Nesbitt (secondary analysis)](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **Job definition fields:** `package-manager`, `source` (provider, repo, directory, commit), `existing-pull-requests`, `security-advisories` (name plus affected ranges), `updating-a-pull-request`, and `dependencies` — [Nesbitt](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **PR refresh:** a job with `updating-a-pull-request: true` refreshes a specific PR. Outcomes are update, close as up to date, close because the dependency was removed, or supersede with a newer PR. Internal close reasons are `dependency_removed`, `up_to_date`, `update_no_longer_possible`, and `dependencies_changed`, and none of them appear in PR metadata — [Nesbitt](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **Security vs version updates:** for security updates, GitHub injects the relevant advisories into each job, and core keeps no vulnerability DB of its own. Version updates come from scheduled registry checks. Alerts, Security Updates, and the dependency graph are three separate systems with different parsing — [Nesbitt](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **Open-source coordinator (dependabot-gitlab):** a Rails app with tables for `projects`, `configurations`, `update_jobs` (cron, `next_run_at`), `update_runs`, `merge_requests`, `vulnerabilities`, and `vulnerability_issues`. Its scheduler uses `FOR UPDATE SKIP LOCKED` to avoid double-scheduling — [Nesbitt](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **Polling critique:** Nesbitt argues polling wastes work, since most scheduled runs find nothing; a 500-dependency repo checked daily makes about 182k registry lookups per year. He proposes event-driven triggers (registry feeds plus push events on manifests) backed by a dependency index — [Nesbitt](https://nesbitt.io/2026/01/02/how-dependabot-actually-works)
- **Move to Actions runners:** since May 2024, Dependabot update jobs run as GitHub Actions workflows on hosted or self-hosted runners (GA). The stated motives are reaching private registries on internal networks and centralizing logs — [GitHub blog](https://github.blog/news-insights/product-news/dependabot-on-github-actions-and-self-hosted-runners-is-now-generally-available)
- **Runner network and scope:** runners need access to the internet, GitHub.com, and any internal registries. Private networking is via Azure VNET or Actions Runner Controller. Self-hosted runners are not used for public repos — [GitHub Docs](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/managing-dependabot-on-self-hosted-runners)
- **GitHub's noise levers** are a version-update cap of 5 open PRs, a fixed security cap of 10, a default 3-day cooldown, groups (including for security updates), and multi-ecosystem groups (see section 2) — [Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)

### Inferences
- **SHAPI fix job contract (stateless, replayable):**
  - Input: `{repo, base_sha, advisory_ids[], existing_pr, codemod_version, mode: create|refresh}`
  - Output: `{file_changes, contract_test, evidence_md, decision: create|update|close(reason)|noop}`

  The coordinator applies the output through the platform layer. Persist close reasons (unlike Dependabot) and show them in the PR, e.g. "Closed: advisory no longer applies after commit abc123". That builds trust.
- **Event-driven where Dependabot polls.** SHAPI's natural design is event-driven: an advisory publish triggers a reverse-index lookup of affected installations, and a push triggers an incremental re-scan of changed files only. This removes most wasted work, the inefficiency Nesbitt identifies in Dependabot.
- **Customer-network execution later.** Running fix jobs on the customer's Actions runners (Dependabot's model) is a credible enterprise option for private code and registries.

### Gaps
- GitHub has not published official engineering details of Dependabot's coordinator: scheduling throughput, internal rate limits, PR volume. Internals here come from one well-regarded secondary source.

## 4. Moderne/OpenRewrite: mass-PR campaigns, review flow, rollback

### Takeaway
Moderne treats a mass change as a recipe run followed by per-repo commit jobs (one job per repo). It offers five commit strategies, retries rate-limited jobs with exponential backoff, and tracks everything in a bulk view. It explicitly says PR state is *not* a measure of progress; re-running the recipe is. No formal rollback exists beyond closing PRs.

### Cited Findings
- **Commit strategies (five):** direct commit, branch, fork, PR, and PR from a fork. Tenant admins control which appear. The PR options are title, body, draft, and auto-merge; PR-from-fork adds "maintainer can modify" — [Moderne docs: track commits](https://docs.moderne.io/user-documentation/moderne-platform/how-to-guides/track-commits)
- **One commit job per repo:** each job creates its commit in the appropriate SCM. On a rate-limit error it backs off exponentially and retries up to 3 times (2, 4, then 8 minutes), then reports the failure reason. "Re-run failed" retries the failures — [Moderne docs](https://docs.moderne.io/user-documentation/moderne-platform/how-to-guides/track-commits)
- **Bulk review and tracking:** the commit view supports approve, merge, and close per row or in bulk. "Blocked" means a review is required or CI is pending. Results export as data. The Moderne Changelog gives one org-wide view of commits and PRs, with check results, review state, and contributors — [Moderne docs](https://docs.moderne.io/user-documentation/moderne-platform/how-to-guides/track-commits); [Moderne changelog](https://docs.moderne.io/user-documentation/moderne-platform/getting-started/changelog)
- **Updating open PRs:** Moderne can keep pushing to an open PR if the changes don't conflict. But if you change the recipe and push again, or someone pushes manually to the branch, Moderne likely can't push further changes — [Moderne docs](https://docs.moderne.io/user-documentation/moderne-platform/how-to-guides/track-commits)
- **Progress is measured by re-running:** "merging a PR doesn't mean the issue is resolved". Re-run the recipe; no results means resolved. PR status isn't a reliable progress measure, so re-run recipes or DevCenters on a cadence — [Moderne docs](https://docs.moderne.io/user-documentation/moderne-platform/how-to-guides/track-commits)
- **Comparable concept:** Sourcegraph's (legacy) campaigns, later "batch changes", create PRs on all affected repos and track them until merged — [Sourcegraph campaigns docs](https://docs-legacy.sourcegraph.com/@3.24/campaigns/explanations/introduction_to_campaigns)

### Inferences
- **Org-level "campaign" view.** For enterprise customers with hundreds of repos affected by one provider change, SHAPI needs a campaign view: one row per repo, with PR state, CI, and contract-test result, plus bulk merge or close and "re-run failed".
- **Re-scan to verify remediation.** Measure remediation by re-scanning after merge (Moderne's "rerun the recipe" principle), not by PR merged. The evidence block plus a post-merge check run confirming "advisory no longer matches" closes the loop.
- **Rollback is revert, not delete.** Neither Moderne nor the others document automated rollback. For SHAPI, rollback means: (a) close unmerged PRs and delete their branches in bulk, and (b) for merged ones, offer a generated revert PR. Keep codemods versioned so a bad codemod version can be quarantined across all open PRs at once.
- **Write-budget pacing for campaigns.** Moderne's 3-retry backoff suits interactive campaigns. SHAPI's always-on app should instead pace work proactively with per-installation budgets, so rate limits are rarely hit at all.

### Gaps
- Moderne campaign or DevCenter docs on campaign-level throttling, PR caps, and rollback were not found in this pass. Its rate-limit thresholds aren't documented.

## 5. Supporting GitLab and Bitbucket later: Renovate's platform abstraction

### Takeaway
Renovate isolates every SCM behind a `Platform` interface (PR, issue, comment, and status operations) plus a `PlatformScm` interface (git operations), with one module per host under `lib/modules/platform/`. SHAPI should define the same seam now, while it has only one implementation.

### Cited Findings
- **Renovate's `Platform` interface** — [Renovate source: lib/modules/platform/types.ts](https://raw.githubusercontent.com/renovatebot/renovate/main/lib/modules/platform/types.ts):
  - **Setup:** `initPlatform`, `initRepo` (returns `defaultBranch`, `isFork`, `repoFingerprint`), `getRepos` (autodiscover), `maxBodyLength()`, `labelCharLimit?()`, and `massageMarkdown(prBody)` (per-host markdown quirks)
  - **Files:** `getRawFile` and `getJsonFile`
  - **PRs:** `getPrList`, `getPr`, `findPr`, `getBranchPr`, `createPr`, `updatePr`, `mergePr`, `reattemptPlatformAutomerge?`, `tryReuseAutoclosedPr?`, `addReviewers`, `addAssignees`, `deleteLabel`, `isBranchMergeQueueEnabled?`, and `isPrInMergeQueue?`
  - **Comments:** `ensureComment` and `ensureCommentRemoval` (by topic or content; idempotent "ensure" semantics)
  - **Issues:** `findIssue`, `getIssueList`, `ensureIssue`, `ensureIssueClosing`, and `getVulnerabilityAlerts?`
  - **Status:** `getBranchStatus`, `getBranchStatusCheck`, and `setBranchStatus`
- **Renovate's `PlatformScm` interface:** `commitAndPush`, `isBranchBehindBase`, `isBranchModified`, `isBranchConflicted`, `branchExists`, `getBranchCommit`, `deleteBranch`, `getFileList`, `checkoutBranch`, `mergeAndPush`, and `syncForkWithUpstream?` — [Renovate source](https://raw.githubusercontent.com/renovatebot/renovate/main/lib/modules/platform/types.ts)
- **Host-specific options:** `PlatformPrOptions` carries flags such as `autoApprove`, `automergeStrategy`, `usePlatformAutomerge`, `gitLabIgnoreApprovals`, and `bbUseDefaultReviewers`. `CreatePRConfig` takes `sourceBranch`, `targetBranch`, `prTitle`, `prBody`, `labels`, `draftPR`, and `milestone` — [Renovate source](https://raw.githubusercontent.com/renovatebot/renovate/main/lib/modules/platform/types.ts)
- **Capability-gated features:** the Dependency Dashboard requires a platform with issues and dynamic Markdown checkboxes. Some features are therefore per-platform — [Renovate dashboard docs](https://docs.renovatebot.com/key-concepts/dashboard/)

### Inferences
- **SHAPI `Platform` interface v1.** Model it on Renovate's:
  - `findPr`, `createPr`, `updatePr`, `closePr`, `ensureComment`
  - `setStatus` (maps to GitHub check runs, GitLab commit statuses / MR notes, and Bitbucket build statuses / Code Insights)
  - `ensureIssue` (dashboard)
  - `getRawFile`, `commitFiles` (one atomic commit)
  - `maxBodyLength` and `massageMarkdown`

  Use "ensure" (idempotent upsert) semantics everywhere. This one decision removes most duplicate-PR and duplicate-comment bugs on retries.
- **Feature-detect the rich surfaces.** Keep GitHub-only surfaces (check-run annotations, `requested_action` buttons) behind capability flags, and fall back to an MR note or status on hosts without them.
- **Push via git, not REST.** Renovate commits via git push (`commitAndPush`) rather than REST blob/tree calls. Git push costs fewer secondary-limit points per multi-file commit, and the approach carries across GitLab and Bitbucket. Consider moving SHAPI from the Git data API to git-over-HTTPS with the installation token (Contents permission). Caveat: on GitHub, commits pushed via git are not signed as the app, whereas API-created commits are shown as verified. This trade-off needs verifying.

### Gaps
- GitLab and Bitbucket API rate limits, webhook semantics, and app/OAuth models were not researched in this pass. Renovate's per-host implementation details (e.g., Bitbucket Cloud vs Server) were not read.
- The claim that API-created commits are verified and git-pushed ones are not is from general knowledge, not a fetched source.

## 6. Surfacing findings: Checks API vs status checks vs PR comments; Slack/Teams notifications

### Takeaway
Use a GitHub check run as the primary surface: a summary plus line annotations, up to 3 action buttons, and a conclusion that can block merge via branch protection. Use the PR body for the human-readable evidence block. Use at most one upserted bot comment (Renovate's `ensureComment` pattern) for anything conversational. Notifications should be digests, never one message per PR.

### Cited Findings
- **Check runs need a GitHub App:** OAuth apps and users can't create them, which rules out SHAPI's current user-token model — [GitHub Docs: Check runs](https://docs.github.com/en/rest/checks/runs)
- **Check run output:** required `title` and `summary` (Markdown), optional `text` (Markdown), `images` (alt, image_url, caption), and `annotations` — [GitHub Docs](https://docs.github.com/en/rest/checks/runs)
- **Annotations:**
  - max 50 per request; send more through "update check run" calls, which append
  - levels: `notice`, `warning`, `failure`
  - each needs `path`, `start_line`, `end_line`, `annotation_level`, `message`
  - `message` and `raw_details` up to 64 KB each, `title` up to 255 chars

  — [GitHub Docs](https://docs.github.com/en/rest/checks/runs)
- **Requested actions:** up to 3 buttons, each with `label` ≤20 chars, `description` ≤40, and `identifier` ≤20. Clicks arrive as `check_run.requested_action` webhooks — [GitHub Docs](https://docs.github.com/en/rest/checks/runs)
- **Conclusions:** `action_required`, `cancelled`, `failure`, `neutral`, `success`, `skipped`, `stale`, and `timed_out`. Only GitHub can set `stale`. Setting a conclusion marks the run completed — [GitHub Docs](https://docs.github.com/en/rest/checks/runs)
- **Renovate's comment and status hygiene:** comments use `ensureComment` / `ensureCommentRemoval` keyed by topic, so there is one comment per topic, updated in place. Statuses use `setBranchStatus` with a `context` — [Renovate source](https://raw.githubusercontent.com/renovatebot/renovate/main/lib/modules/platform/types.ts)
- **Muting categories:** Renovate's `suppressNotifications` mutes categories such as `prEditedNotification`, `onboardingClose`, and `lockFileErrors` — [Renovate config options](https://docs.renovatebot.com/configuration-options/)

### Inferences
- **Two check-run patterns:**
  - On SHAPI fix PRs: a `SHAPI / contract-test` check showing the generated contract test result, with `success` / `failure`.
  - On *customer* PRs (via `pull_request` and `check_suite` webhooks): a `SHAPI / API-change impact` check that annotates newly added call sites using deprecated or sunsetting endpoints. It concludes `neutral` (informational) or `action_required` (deadline-imminent). Buttons: "Open fix PR", "Snooze 30d", "Ignore advisory".

  This turns SHAPI into an ongoing review gate, not just a PR opener.
- **Avoid status checks for new work.** Prefer check runs over commit statuses on GitHub; statuses lack annotations and buttons. Keep statuses only as the cross-platform least common denominator in the platform layer.
- **Slack and Teams:**
  - Send a daily or weekly digest per installation: new advisories matched, PRs opened, merged, or failing, and deadlines in under 14 days.
  - Send immediate messages only for deadline-critical or already-breaking advisories, mirroring the security carve-out.
  - Make the channel a per-org setting. Link to the dashboard or campaign view, not individual PRs.

### Gaps
- No primary source was fetched on Slack/Teams notification practice from Renovate, Dependabot, or Moderne (Dependabot and GitHub rely on GitHub notifications and security-alert emails). The recommendations above are inference.
- Character limits for check-run `summary` and `text` (commonly 65,535) were not stated on the fetched page.
