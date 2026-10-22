# SHAPI backend architecture, security and compliance (research notes, retrieved 2026-10-22)

All prices were read from vendor pages or third-party estimates on 2026-10-22. Prices change often, so re-check them before budgeting. Items marked "unverified" come from background knowledge and were not confirmed in this session.

## Job orchestration: which engine for scheduled canaries, fan-out scans and long-running repair jobs?

### Takeaway
Start with Trigger.dev Pro ($50/mo) or Hatchet (pay-as-you-go, MIT-licensed, Postgres-based). Both have cron, no hard run-duration cap (Trigger.dev) and per-second compute (Trigger.dev), and both are cheap at about 100 APIs x hourly probes. Temporal Cloud is the most durable option for long LLM repair workflows, but its Business tier costs $500/mo or more. Pay-as-you-go Temporal at $50 per million actions works if action counts stay low. BullMQ/Redis is the cheapest, but you have to build durability and observability yourself.

### Cited Findings
- Temporal Cloud Pay-As-You-Go has no base fee, starts at $50 per million actions and drops to $25 with self-service volume pricing. Storage costs $0.042/GB-hr active and $0.00105/GB-hr retained. New accounts get $150 in credits for 90 days. — [Temporal pricing](https://temporal.io/pricing)
- Temporal Business starts at $500/mo (or 10% of usage, whichever is greater) and includes 2.5M actions, 2.5 GB active and 100 GB retained storage. Enterprise includes 10M actions and SCIM. The pricing page links a "Startups" page but gives no terms for it. — [Temporal pricing](https://temporal.io/pricing)
- Inngest plans:
  - Free: 50k executions/mo, 5 concurrent steps, 24h trace history, 30-day max run length. Execution pauses when the quota is reached.
  - Pro: $99/mo for 1M executions, 100 concurrent steps, 7-day history, 90-day max run. Overage is $0.000050 to $0.000015 per execution, plus $25 per 25 extra concurrent steps.
  - Business: $499/mo for 10M executions, 500 concurrency, 366-day max run.
  - [Inngest pricing](https://www.inngest.com/pricing)
- Trigger.dev plans:
  - Free: $0 with $5 of credits, 20 concurrent runs, 10 schedules, 1-day logs.
  - Hobby: $10.
  - Pro: $50/mo with $50 of credits, 200+ concurrent runs, 1,000+ schedules, 30-day logs.
  - "Runs have no maximum duration" (maxDuration is configurable).
  - Compute: $0.0000338/s for Small 1x (0.5 vCPU, 0.5 GB), $0.000085/s for Medium 1x (1 vCPU, 2 GB), $0.00034/s for Large 1x (4 vCPU, 8 GB), plus $0.000025 per run invocation.
  - The pricing page does not mention static IPs.
  - [Trigger.dev pricing](https://trigger.dev/pricing)
- Hatchet Cloud plans:
  - No card: 2,000 task runs/day, 1-day retention. Over the limit, tasks are dropped.
  - Card on file: 1M runs/mo included, then $30/M. Events cost $5/M. 10,000 worker slots, 1M scheduled runs, 7-day retention, 10 GB storage then $0.03/GB-hr.
  - Open source under MIT, so it can be self-hosted.
  - [Hatchet pricing](https://hatchet.run/pricing)
- I found no fresh sources on AWS Step Functions or BullMQ pricing or features in this session (see Gaps).

### Inferences
- Probe volume estimate: 100 APIs x ~5 endpoints x hourly = about 360k probe runs/mo.
  - Hatchet: inside the 1M free runs on the card-on-file tier.
  - Trigger.dev: invocation fees are about $9/mo. A Micro/Small machine running ~2s per probe adds roughly $12–25/mo of compute, which fits in or near the $50 Pro credit.
  - Inngest Pro: covers it ($99).
  - Temporal: 360k workflows x roughly 5–10 actions each = 1.8–3.6M actions, or about $90–180/mo on pay-as-you-go.
- Repair jobs (clone, LLM loop, run tests in a sandbox, open a PR) can last minutes to hours and need human-in-the-loop waits. Temporal and Inngest/Trigger.dev "waitForEvent/wait" primitives fit. Trigger.dev's per-second compute bills sandbox CPU directly, and Temporal needs you to run your own workers.
- Recommended path:
  1. Now: one durable engine (Trigger.dev or Hatchet) for both canaries and repairs. Use Postgres as the system of record and idempotency keys per (tenant, repo, advisory).
  2. Later: revisit Temporal when repair workflows become multi-step sagas with strict exactly-once side effects (for example, PR creation).
- Egress-IP stability: canary probes that hit IP-allowlisting providers should run on your own workers behind a static egress IP (see Hosting). Hosted-compute engines can't provide this unless they offer static IPs, which is not shown on Trigger.dev's pricing page.

### Gaps
- No verified current pricing for AWS Step Functions, or for Redis hosting for BullMQ (Upstash/ElastiCache).
- No terms found for the Temporal startup program.
- Inngest's maximum step duration is not on the pricing page.
- Whether Trigger.dev Cloud offers static egress IPs is not confirmed.

## Data: Postgres, ClickHouse, TimescaleDB or partitioning, and multi-tenancy

### Takeaway
Use managed Postgres for tenants, advisories, locks and job state. Store shape time series in plain Postgres with native time partitioning (or TimescaleDB) until you have hundreds of millions of rows or need heavy analytic scans. Even the smallest ClickHouse Cloud service runs about $200–300/mo for always-on compute. For multi-tenancy, use a shared schema with tenant_id plus Postgres row-level security (RLS).

### Cited Findings
- ClickHouse Cloud tiers:
  - Basic: up to 1 TB, 8–12 GiB memory, single AZ.
  - Scale: unlimited storage, 2+ AZ, private networking.
  - Enterprise: SAML SSO, CMEK, HIPAA/PCI.
  - [ClickHouse pricing](https://clickhouse.com/pricing)
- ClickHouse Cloud rates and trial:
  - Published Enterprise rates for AWS us-east-1: $0.39030 per compute unit-hour (1 unit = 8 GiB RAM / 2 vCPU) and $25.30/TB-month storage. Public egress is $0.115/GB.
  - Basic and Scale rates are not published on the page and need the calculator.
  - Trial: $300 in credits over 30 days.
  - [ClickHouse pricing](https://clickhouse.com/pricing)
- Illustrative cost: one always-on compute unit at the Enterprise us-east-1 rate is about $286/mo (732 h x $0.3903). Basic is likely cheaper, and idle scaling can lower it. — derived from [ClickHouse pricing](https://clickhouse.com/pricing)

### Inferences
- Shape data volume: ~500 endpoints x hourly x 1 row each = about 4.4M rows/yr. That is trivially within Postgres's range. Store a shape hash per probe plus a full shape document only when the hash changes, which cuts storage further.
- When ClickHouse becomes warranted:
  - Opt-in customer shape telemetry (high-cardinality field distributions across many tenants).
  - Analytics like "percent of traffic seeing field X null over 30 days".
  - Ingest beyond about 10^8–10^9 rows.
- Multi-tenancy recommendation:
  - Shared tables with `tenant_id` on every row, enforced by RLS policies plus a per-request `SET app.tenant_id`.
  - Per-tenant schemas add migration pain and only pay off for regulated or enterprise isolation asks. Offer a dedicated database (single-tenant) as an Enterprise upsell instead.
- Advisories and canary observations are global (not tenant-scoped) data. Keep them in separate tables without RLS, and keep tenant-specific impact and scan results under RLS.

### Gaps
- No Timescale Cloud pricing was fetched (Timescale has rebranded as TigerData, unverified), and Postgres RLS documentation was not fetched. The RLS recommendation reflects standard practice and was not sourced this session.
- ClickHouse Basic and Scale per-hour rates are unpublished on the page.

## Hosting: Fly.io, Render, Railway, ECS/Fargate or Cloud Run, and stable egress IPs

### Takeaway
Fly.io is the cheapest way to get static egress for the canary fleet: $3.60/mo per app-scoped IPv4 per region, and the IP persists across deploys. Render offers dedicated outbound IP sets (3 IPv4s) on Pro+ workspaces at about $100/mo per set. AWS/GCP need a NAT gateway with an Elastic or static IP, which is more setup and has a higher fixed cost (unverified figures).

### Cited Findings
- Fly.io static egress IPs:
  - Default Fly egress IPs "are unstable and may change." You allocate static ones with `fly ips allocate-egress --app <app> -r <region>`.
  - They are app-scoped and cost $3.60/mo per IPv4; IPv6 is included. They persist across Machine destruction and deploys, and you need one per region.
  - Limits: up to 64 Machines per IP per region, and 1,024 concurrent connections per destination IP. Machine-scoped IPs are deprecated.
  - [Fly.io egress IPs docs](https://docs.fly.io/networking/egress-ips)
- Render Dedicated IPs:
  - Each set has 3 static IPv4s in one region and can cover the whole workspace or selected environments.
  - Requires a Pro workspace or higher. Up to 4 sets per workspace by default.
  - Price: $100/month per IP set per the May 19, 2026 changelog.
  - [Render changelog](https://render.com/changelog/add-dedicated-outbound-ips-to-your-workspace); [Render dedicated IPs docs](https://render.com/docs/dedicated-ips)

### Inferences
- Suggested topology:
  - Web, API, webhook receivers and MCP server on Fly.io or Render.
  - Canary workers on a separate Fly app with one static egress IP per region. Publish these IPs to providers and customers on a "SHAPI egress IPs" docs page.
  - Sandboxed repair jobs on separate, network-restricted infrastructure (Fly Machines, Firecracker-based, unverified), or a managed sandbox provider.
- Early-stage monthly infra estimate: managed Postgres $15–50, 2–4 small app machines $20–60, egress IPs $4–15 on Fly, plus orchestration $0–99. That puts the total around $100–250/mo before LLM spend. This is an inference, not a quote.
- Move to AWS (ECS/Fargate plus RDS) once enterprise customers ask for VPC peering, PrivateLink or a specific region or residency. A move there also simplifies SOC 2 evidence because Vanta and Drata integrate deeply with AWS (unverified).

### Gaps
- Railway, Cloud Run and Fargate pricing were not fetched. The cost of NAT gateways or Cloud NAT static IPs was not verified.
- Fly.io and Render base compute prices were not fetched this session.

## Secrets and provider test accounts: Vault, Doppler, 1Password or AWS Secrets Manager; OAuth rotation; ToS and rate limits

### Takeaway
Use Doppler Team ($21/user/mo, includes automatic rotation, SAML and 90-day logs) or a cloud secrets manager for static secrets. Store rotating OAuth refresh tokens in Postgres, encrypted (envelope encryption with KMS), and protect each refresh with a per-credential lock, because providers like QuickBooks rotate the refresh token roughly every 24 hours and concurrent refreshes cause `invalid_grant`.

### Cited Findings
- Doppler plans:
  - Developer: free for 3 users, then $8/user/mo. 3-day activity logs, 50 service tokens.
  - Team: $21/user/mo with SAML SSO, RBAC, 90-day logs and "Automatic secret rotation".
  - Enterprise: custom, with dynamic secrets and on-prem.
  - SOC 2 status was not stated on the pricing page (it links trust.doppler.com).
  - [Doppler pricing](https://www.doppler.com/pricing)
- QuickBooks (Intuit) tokens:
  - The FAQ says refresh tokens are valid for 100 days, and the value changes every 24 hours (old values become stale).
  - Intuit's newer policy announces a maximum 5-year validity: accounting and payments-scope tokens start expiring in October 2028, and restricted or granular scopes in February 2027. The refresh endpoint will return an expiry field.
  - [Intuit Authorization FAQ](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq); [Intuit refresh token policy](https://medium.com/intuitdev/important-changes-to-refresh-token-policy-8443779d40db)
- Concurrent refreshes produce `invalid_grant` (Worker B refreshes with an already-stale token), so put a lock around refresh logic. — [Nango blog](https://www.nango.dev/blog/quickbooks-oauth-refresh-token-invalid-grant)
- Intuit uses separate Development and Production credentials, and mismatches look like bad-refresh-token errors. — [Truto QBO guide](https://truto.one/blog/how-to-integrate-with-the-quickbooks-online-api-2026-guide)

### Inferences
- Credential model:
  - A `provider_credentials` table holds the KMS-encrypted refresh token, expiry, last-rotated time and owner account.
  - Refresh runs as a single-flight job per credential, using a Postgres advisory lock or the orchestrator's concurrency key = credential_id.
  - Raise an alert when a refresh fails (this is a "canary-infra failure", not an API change).
  - Doppler, Vault or Secrets Manager holds only static client IDs and secrets and the KMS key references.
- Vault is overkill pre-Series A unless you need dynamic DB credentials. 1Password Secrets Automation suits a team already on 1Password (unverified).
- Probe cadence: keep it well inside each provider's published rate limits (for example, a few calls per endpoint per hour). Use the providers' official sandbox or developer accounts and register them under SHAPI's company identity.

### Gaps
- Not fetched: Vault, 1Password Secrets Automation and AWS Secrets Manager pricing, and Xero and HubSpot token lifetimes.
- I did not review provider ToS clauses on automated or benchmark probing for QuickBooks, Xero, HubSpot and others. Legal review of each developer agreement is recommended before publishing comparative change data.

## Observability: OpenTelemetry stack and alerting on canary failures versus real API changes

### Takeaway
No vendor pricing was fetched this session. The recommended design is OpenTelemetry instrumentation exporting to one backend (Grafana Cloud or Honeycomb free tiers, unverified), plus Sentry for exceptions. Classify canary results into separate signals so that infrastructure failures don't page as "API changed".

### Cited Findings
- No sources were fetched for Grafana, Honeycomb, Datadog or Sentry pricing.

### Inferences
- False-positive control:
  - Separate the outcome classes: transport/auth failure (5xx, timeouts, 401, `invalid_grant`), rate limit (429), and shape diff (2xx with a changed schema).
  - Declare a shape change only after N consecutive or multi-region confirmations (for example, 2 of 3 probes across 2 egress IPs).
  - Normalize volatile fields (IDs, timestamps, nullable optional fields) before hashing.
  - Diff against a rolling baseline, not just the last sample.
  - Route infra failures to an internal on-call channel and confirmed shape changes to the advisory pipeline.
- Track SLOs: probe success rate per provider, time from shape change to advisory, and the repair job success rate.

### Gaps
- Current pricing and free-tier limits for Grafana Cloud, Honeycomb, Datadog and Sentry were not retrieved.

## Security and compliance to sell to companies: SOC 2, GitHub App scopes, code retention, DPAs and peer practices

### Takeaway
Budget about $20–60k in year one for a SOC 2 path:
- Platform: Vanta, Drata, Secureframe or Oneleet, roughly $7.5–15k/yr at startup tier.
- Audit: about $15–40k for Type II.
- Pentest: about $10k, bundled with Oneleet.

A Type I takes about 2–3 months. Type II adds a 3–12 month observation window. Peer dev-tool companies sell on "ephemeral per-job sandbox, code deleted after analysis, never used for training, SOC 2 Type II", and SHAPI should copy that posture and language.

### Cited Findings
- SOC 2 cost estimates (all third-party and vendor-affiliated, so they vary widely):
  - First-year startup total: $20–60k ([cipherssecurity](https://cipherssecurity.com/?p=16428)). Series A/B Type II: $50–110k ([Agency](https://blog.getagency.com/articles/soc-2-audit-cost-for-startups)).
  - Vanta: about $10–12k/yr for teams under 50 people. Drata entry tier: $7.5–15k/yr ([cipherssecurity](https://cipherssecurity.com/?p=16428)). Another source gives Vanta $15–20k and Drata $12–18k ([Tracelayer](https://tracelayer.it.com/blog/soc2-compliance-cost-2026)).
  - Type II auditor fees: $15–40k, and Big 4 $30–80k+ ([Tracelayer](https://tracelayer.it.com/blog/soc2-compliance-cost-2026)).
- SOC 2 timeline: a seed-stage, Security-only Type II takes about 3–6 months, and the observation window is usually 3–12 months. — [guptadeepak.com](https://guptadeepak.com/guides/soc-2-for-startups/); 6–12 months for a platform-led approach — [Petronella](https://petronellatech.com/blog/soc-2-compliance-cost-in-2026-what-startups-actually-pay)
- Secureframe is quote-only, estimated at about $7.5–15k/yr (startup) and $15–30k+ (growth). Its pentest is sourced via partners and bought separately. — [Strac](https://www.strac.io/blog/secureframe-pricing); [CostBench](https://costbench.com/software/compliance-management/secureframe/) (competitor-authored sources)
- Oneleet bundles in-house manual pentesting and vCISO services, and a partner CPA firm issues the report. It runs one framework at a time. Estimates are about $8–60k/yr. — [soc2auditors.org review](https://soc2auditors.org/insights/oneleet-review/); [soc2auditors.org pricing](https://soc2auditors.org/insights/oneleet-pricing/); [ComplyJet](https://www.complyjet.com/blog/oneleet-pricing-exposed)
- CodeRabbit's code-handling posture:
  - Each review runs in an isolated sandbox provisioned per event and destroyed after completion.
  - "We do not store your code... disposed of as soon as the review is complete."
  - Proprietary code is never used to train models. LLM queries are ephemeral and not logged by the LLM providers.
  - The sandbox holds only a short-lived token for that one repository, and no other secrets.
  - SOC 2 Type II, renewed annually.
  - [CodeRabbit FAQ](https://coderabbit.ai/FAQ); [CodeRabbit trust center](https://coderabbit.ai/coderabbit-trust-center); [CodeRabbit security posture blog](https://coderabbit.ai/blog/our-security-posture-how-we-safeguard-your-repositories)
- CodeRabbit's January 2025 Kudelski disclosure involved Rubocop running outside the sandbox. CodeRabbit reported no evidence that customer data was accessed. The lesson for SHAPI: every third-party tool that executes on customer code must run inside the sandbox. — [CodeRabbit response](https://coderabbit.ai/blog/our-response-to-the-january-2025-kudelski-security-vulnerability-disclosure-action-and-continuous-improvement)
- Greptile's code-handling posture:
  - Stores customer code on an encrypted filesystem and keeps it cached until repo access is revoked, then deletes it.
  - Offers a fully self-hosted or air-gapped deployment.
  - Chat logs are kept in DynamoDB and support staff may access them.
  - SOC 2 Type II.
  - [Greptile security](https://greptile.com/security); [Greptile enterprise](https://www.greptile.com/enterprise); [Greptile self-host docs](https://www.greptile.com/docs/security/selfhost.md)
- Snyk's code-handling posture:
  - Snyk Code temporarily clones repos for one-time analysis and caches code according to the cloud provider's storage-minimum policy. It then keeps only issue locations and explanations, and removes the code.
  - Snyk Open Source with SCM Workspaces takes short-lived shallow clones and scans only manifest and lock files.
  - [Snyk data handling](https://docs.snyk.io/working-with-snyk/how-snyk-handles-your-data)

### Inferences
- SHAPI code-handling policy to publish:
  1. GitHub App with least privilege: Contents read (write only if auto-PR is enabled, or request it as a separate opt-in installation), Metadata read, Pull requests write only for fix PRs, Checks write optional. Webhooks for push, PR and installation events.
  2. Shallow, ephemeral clones per job, using installation tokens scoped to that one repo (GitHub installation tokens expire after about 1 hour, unverified).
  3. Persist only a dependency/call-site index (file path, line, symbol, SDK version), never raw source. Optionally offer a "zero persistence" mode.
  4. Use LLM providers with zero-data-retention terms, and promise no training on customer code.
  5. Delete all derived data on uninstall, within a stated number of days.
  6. Shape-only telemetry: field names and types only, never values. Hash or redact the keys of dynamic maps.
- Sequencing:
  1. Weeks 0–4: platform plus policies, MFA, SSO for staff, CI security, and a trust page.
  2. Months 2–3: SOC 2 Type I.
  3. Months 3–9: Type II observation window.
  4. Add a pentest before the first enterprise deal. Oneleet's bundle avoids buying the pentest separately.
- GDPR for a US startup selling globally:
  - Publish a DPA with SCCs (EU–US Data Privacy Framework certification is optional) and a subprocessor list (cloud, LLM vendors, observability).
  - Keep a record of processing, and set retention limits.
  - SHAPI is mostly a processor of customer code, and committer names and emails in git metadata are personal data.
  - These points are background knowledge, not sourced this session.

### Gaps
- Not fetched this session: Vanta and Drata official pricing (they don't publish list prices), Socket.dev's code-handling statements, Renovate/Mend's hosted-app data policy, GitHub App permission docs, and EU GDPR/DPF primary sources.

## Auth and billing: Clerk, WorkOS or Auth0 for SSO/SAML, and Stripe Billing for usage-based pricing

### Takeaway
WorkOS AuthKit is free up to 1M MAU. Enterprise SSO and SCIM cost $125 per connection per month (dropping to $65 at volume). You can pass that cost through on an Enterprise tier, which makes WorkOS a good fit for a dev-tool selling up-market. Clerk, Auth0 and Stripe pricing were not verified this session.

### Cited Findings
- WorkOS pricing:
  - AuthKit: free for the first 1M MAU, then $2,500/mo per additional 1M.
  - SSO per connection: $125 each for 1–15, $100 for 16–30, $80 for 31–50, $65 for 51–100. Directory Sync uses the same pricing.
  - Audit-log streaming: $125/mo per SIEM. Retention: $99/mo per 1M events. Custom domain: $99/mo.
  - [WorkOS pricing](https://workos.com/pricing)

### Inferences
- Use GitHub OAuth for developer login. Add SAML/SCIM via WorkOS only for Enterprise-plan customers, priced at least $125/mo above the cost.
- Billing: Stripe Billing usage-based meters (for example, per monitored repo, per repair job or per seat) with a platform fee. Current Stripe Billing fee levels are unverified and need checking.

### Gaps
- Not fetched: Clerk pricing (SAML/enterprise connection costs), Auth0 B2B pricing, and Stripe Billing fees and meter limits.
