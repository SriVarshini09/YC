# Verification, Secure Sandboxing, and Guarded LLM Code Repair for SHAPI (research as of 2026-10-22)

Scope: what SHAPI should use to (a) generate and run contract tests from old/new provider response shapes against customer code, (b) execute untrusted customer repos (install scripts plus tests) safely, and (c) run a verification-gated Claude repair loop. Pricing dates are noted inline. Pages were fetched on 2026-10-22 unless stated otherwise.

## Contract testing, mocks and record/replay: which tools fit "generate a test from old/new response shapes and run it against the customer's own code" (Node, Python, Go, Java)?

### Takeaway
SHAPI's test is a consumer-side test: it runs the customer's client code against a stubbed provider that returns the old shape and then the new shape. That points to spec-driven mock servers (Prism, WireMock with OpenAPI validation) and in-process HTTP stubbing and record/replay libraries (nock or Polly.js for Node, VCR.py for Python, go-vcr for Go, WireMock for Java), driven by a SHAPI-generated fixture. Pact is consumer-driven and works in all four languages, but it assumes provider buy-in and a broker workflow. Schemathesis and Keploy target other problems: Schemathesis fuzzes providers, and Keploy records the customer's own traffic.

### Cited Findings
- **Schemathesis** "automatically generates property-based tests from your OpenAPI or GraphQL schema". It supports OpenAPI 2.0 through 3.2 and GraphQL, ships a CLI, a Python API and pytest integration, and "catches server errors, schema violations, and validation gaps". Its docs describe pointing it at an API, which is provider/server-side testing. They make no claim about testing client code. — [Schemathesis docs](https://schemathesis.readthedocs.io/en/stable/)
- **Pact** is consumer-driven: consumers write expectations, providers verify them, and contracts are shared through a Pact Broker or PactFlow (commercial). — [Keploy vs Pact comparison (vendor)](https://keploy.io/compare/pact)
- The Pact Specification V4 was ratified on 2022-01-20. It added synchronous messages, mixed HTTP and message interactions in one pact file, and user-defined plugins. pact-jvm master is "V4 + plugins", JDK 17+. — [Pact Specification](https://docs.pact.io/implementation_guides/pact_specification); [pact-jvm](https://github.com/dius/pact-jvm); [PactFlow blog: V4 and plugins](https://pactflow.io/blog/pact-v4-and-plugins)
- Current V4 support in pact-js, pact-python and pact-go could not be confirmed. The only data found is from a May 2022 changelog, where pact-js had V3 beta and pact-go 2.x was in beta. — [PactFlow OSS changelog May 2022](https://pactflow.io/blog/changelog-oss-may-2022/)
- **Keploy** records real API traffic at the kernel level with eBPF probes on socket syscalls (sendto/recvfrom/read/write), replays it as regression tests, and auto-generates mocks for downstream dependencies. These claims come from vendor material. — [Keploy record/replay](https://keploy.io/record-replay-testing); [Keploy vs Pact](https://keploy.io/compare/pact)
- **Prism (Stoplight)** is spec-first. It mocks from OpenAPI 2/3 or Postman files and returns static examples from the spec by default. Its validation proxy checks both requests and responses against the OpenAPI operation, and response validation was added in Prism 3.2. Prism runs as a CLI HTTP server and "is not yet intended for programmatic mocking within test suites". — [Stoplight blog](https://blog.stoplight.io/prism-open-source-mock-server-gets-smarter); [jvt.me Prism guide](https://www.jvt.me/posts/2022/03/04/openapi-local-prism/)
- **WireMock** offers OpenAPI validation in three modes: none (default), soft (non-compliant traffic is logged with warnings) and hard. It covers both requests and responses. — [WireMock docs: OpenAPI validation](https://docs.wiremock.io/openAPI/openapi-validation)
- **Polly.js (Netflix)** records, replays and stubs HTTP in Node and the browser, and persists interactions as HAR. Starting a recording can require changes to app code. — [@pollyjs/core](https://classic.yarnpkg.com/en/package/@pollyjs/core); [mockyeah compare](https://mockyeah.js.org/compare)
- **nock** is Node-only HTTP mocking with no real server and no browser support. — [mockyeah compare](https://mockyeah.js.org/compare)
- **go-vcr** records and plays back HTTP interactions through Go's `http.Client` transport, in the style of Ruby VCR. — [go-vcr summary](https://best-of-web.builder.io/library/dnaeon/go-vcr) (aggregator, low quality)

### Inferences
- **Recommended primary mechanism.** SHAPI already knows the old and new response shapes. It should emit a per-language test that stubs the provider at the HTTP layer and asserts the customer's call site handles the response:
  - Node: nock or msw
  - Python: `responses`, respx or VCR.py cassettes
  - Go: `httptest.Server` or go-vcr
  - Java: WireMock

  In-process stubs avoid network egress during test runs and are deterministic. An HTTP-level stub is also language-agnostic, because one fixture (old.json/new.json) is served per language harness.
- **Cross-language fallback.** Run one Prism or WireMock server per sandbox, loaded with an OpenAPI fragment (old and new variants), and point the customer's base URL at it through an env var. WireMock's hard validation mode can also catch requests the customer sends that the new spec rejects. This works only when the customer's SDK base URL is configurable, and most official SDKs (Stripe, GitHub Octokit, OpenAI) allow that.
- **Pact is a poor primary fit.** Its value is the provider verifying contracts, and SHAPI's providers (Stripe, GitHub and others) will not run SHAPI's pacts. Pact's consumer DSL could still serve as the test format in Java and JS shops that already use it.
- **Schemathesis does not fit the core loop.** It tests providers. At most it could fuzz the provider's sandbox to discover shape changes, which belongs on SHAPI's detection side, not verification.
- **Keploy and Polly-style recording** help bootstrap realistic fixtures from a customer's existing integration-test traffic. A synthesized "new shape" fixture still has to be derived from the provider's changelog or OpenAPI diff.

### Gaps
- No primary sources were found for VCR.py, Hoverfly or Microcks capabilities in this pass. Microcks' response validation and multi-protocol mocking are unverified.
- Current V4 and plugin status of pact-js, pact-python and pact-go is unconfirmed.
- There are no independent benchmarks of Keploy's eBPF overhead. Only vendor claims exist.

## Running tests in provider sandboxes (Stripe, Shopify, GitHub, QuickBooks): practices and pitfalls

### Takeaway
Provider sandboxes are useful for an optional live confirmation step after the stubbed contract test passes. They add per-provider rate limits, expiry and setup overhead, and they risk leaking real credentials into untrusted code. Stripe is the most automation-friendly: it can provision anonymous sandboxes from the CLI. QuickBooks sandboxes expire and are capped.

### Cited Findings
- **Stripe** sandboxes are isolated test environments where "payments you create aren't processed by card networks". Stripe recommends general sandboxes over the legacy test-mode sandbox for new integrations, and "separate sandboxes for local development and continuous integration (CI)". — [Stripe Sandboxes docs](https://docs.stripe.com/sandboxes)
- Stripe now documents that coding agents can run `stripe sandbox create` to "provision an anonymous Stripe sandbox with working API keys. No account registration required." — [Stripe Sandboxes docs](https://docs.stripe.com/sandboxes)
- Stripe sandbox limits: IC+ pricing can't be tested, and Connect platform sandboxes can't connect to connected-account sandboxes. — [Stripe Sandboxes docs](https://docs.stripe.com/sandboxes)
- **QuickBooks Online** sandboxes are available only for the Plus edition. They are valid for two years and can't be renewed. Each developer account is capped at 10 sandbox companies, apps get 500 requests per minute, and test email is limited to 40 per day per sandbox. — [Intuit Sandbox FAQ](https://developer.intuit.com/app/developer/ies/docs/develop-your-app/sandboxes/sandbox-faqs); [QB Payments sandbox FAQ](https://developer.intuit.com/app/developer/qbpayments/docs/develop/sandboxes/sandbox-faqs)
- **Shopify** development stores: charges are not real (Shopify asks you to authorize them but flags them as not actual charges). Third-party apps may only connect to sandbox counterparts, for example a QuickBooks sandbox company. This is vendor documentation, not Shopify's. — [MyWorks docs](https://support.myworks.software/using-myworks-in-a-shopify-development-store)

### Inferences
- Use provider sandboxes only as an optional second gate ("live smoke"), never as the primary oracle. They are non-deterministic, rate-limited and need SHAPI-owned credentials.
- Never inject the customer's live keys into the sandbox. Use SHAPI-owned sandbox keys, or Stripe's anonymous sandboxes, scoped per job and revoked after the run. The customer's code is untrusted and can exfiltrate any env var.
- **Pitfall: API version pinning.** Stripe pins API versions per account and per request header. The test must set the target version explicitly, or a sandbox run silently exercises the old shape. This is general Stripe behaviour and was not re-verified in this pass.
- GitHub has no sandbox product. The usual practice is a dedicated test org or repo plus a fine-grained PAT. This is not verified here (see Gaps).

### Gaps
- No primary source was fetched for Shopify development-store API limits or for GitHub test-org practices.
- Stripe sandbox rate limits and the number of sandboxes per account were not on the fetched page.

## Secure sandboxes for untrusted customer code: isolation, cold start, price, egress, secrets, caching

### Takeaway
SHAPI runs customers' install scripts and tests, so the minimum bar is VM-grade isolation (a Firecracker or KVM microVM, or gVisor at minimum) with default-deny egress and no customer secrets inside. The best fit is E2B or Daytona at about $0.05 per vCPU-hour plus $0.016 per GiB-hour. Modal Sandboxes are about 3x pricier but strong on images and caching. Cloudflare Containers suits edge-close workloads but meters differently. Running in the customer's own GitHub Actions is a strong option for enterprise trust: the code never leaves their CI and they pay for the minutes, at the cost of latency and setup friction.

### Cited Findings: pricing (fetched 2026-10-22)

| Provider | Published rates | Plans, limits, credits | Approx. cost of 2 vCPU / 4 GiB per hour |
|---|---|---|---|
| E2B | $0.000014 per vCPU-s, $0.0000045 per GiB-s; storage included; 1–8 vCPU, 1–8 GiB, CPU only | Hobby: $0 with one-time $100 credit, 20 concurrent, 1 h max session. Pro: $150/mo + usage, 100 concurrent, 24 h sessions (600-sandbox add-on $650/mo). Enterprise minimum $3,000/mo; BYOC on Enterprise only | ~$0.166 |
| Modal Sandboxes | Non-preemptible rates: $0.00003942 per core-s (~$0.142/core-h), $0.00000667 per GiB-s (~$0.024/GiB-h). That is 3x standard Functions ($0.0000131 per core-s). Region selection adds 1.15–1.75x | Starter: $30/mo free credits, 100 containers. Team: $250/mo, $100 credits, 5,000 containers | ~$0.38 |
| Daytona | $0.0504 per vCPU-h, $0.0162 per GiB-h, storage $0.000108 per GiB-h after 5 GiB free; per-second billing | $200 free compute; startups up to $50k credits; BYOC on Enterprise. Claims "sub 90ms sandbox creation". Isolation technology not stated on the pricing page | ~$0.166 (same rates as E2B) |
| Cloudflare Containers (page last updated 2026-10-05) | $0.000020 per vCPU-s (active CPU only), $0.0000025 per GiB-s (provisioned), disk $0.00000007 per GB-s, billed in 10 ms increments. Egress $0.025/GB in NA/EU with 1 TB included | Workers Paid ($5/mo) includes 25 GiB-h memory, 375 vCPU-min and 200 GB-h disk. Instance types run from lite (1/16 vCPU, 256 MiB) to standard-4 (4 vCPU, 12 GiB). No separate Sandbox SDK price on this page | Not computed; the 2 vCPU tier is standard-3 with 8 GiB, roughly $0.22/h fully busy |
| Fly Machines (2026-10-01 pricing update) | Per-second billing. shared-cpu-1x 256 MB is $0.0030/h ($2.19/mo), up from $1.94/mo. Egress $0.02/GB in NA/EU | — | Not computed |
| GitHub Actions hosted runners | Linux 2-core $0.006/min ($0.36/h), Linux 1-core $0.002/min, Windows $0.010/min, macOS $0.062/min. Prices were cut by up to 39% from 2026-01-01. The planned $0.002/min self-hosted fee (announced Dec 2025 for 2026-03-01) was postponed | — | $0.36, billed to the customer, not SHAPI |

Sources:
- E2B — [E2B pricing](https://e2b.dev/pricing)
- Modal — [Modal pricing](https://modal.com/pricing)
- Daytona — [Daytona pricing](https://www.daytona.io/pricing)
- Cloudflare — [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- Fly — [Fly 2026 pricing update](https://fly.io/pricing-update/); [Fly resource pricing](https://fly.io/docs/pricing/). A third-party figure conflicts with Fly's, and a "$6/GB-month extra RAM" figure in the search summary was not verified on the primary page.
- GitHub Actions — [GitHub runner pricing reference](https://docs.github.com/es/enterprise-server@3.15/billing/reference/actions-runner-pricing); [OpenMetal on the postponement](https://openmetal.io/resources/blog/the-real-cost-math-behind-self-hosted-github-actions-runners/). An early-2026 Substack post still describes the self-hosted fee as in effect: [Platform Engineering Substack](https://theplatformengineering.substack.com/p/github-actions-2026-pricing-changes).

**Anthropic Managed Agents (cloud environment):** $0.08 per session-hour of `running` time plus tokens. Session runtime replaces code-execution container-hour billing, so container hours are not billed on top. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

### Cited Findings: isolation and network
- **Firecracker** boots to user-space code in about 125 ms, with under 5 MiB memory overhead per microVM and up to 150 microVM launches per second per host. These figures come from secondary sources quoting Firecracker's published numbers. — [Northflank: what is Firecracker](https://northflank.com/blog/what-is-aws-firecracker); [Fly.io: Firecracker vs gVisor](https://fly.io/learn/firecracker-vs-gvisor/)
- **gVisor** has no guest kernel to boot, so its cold start is close to a process start. It trades that for I/O cost; one vendor table cites about 10–30% syscall-heavy I/O overhead (unverified). Firecracker offers better I/O and a KVM-bounded attack surface, with slightly slower start and more memory. — [Northflank: Firecracker vs gVisor](https://northflank.com/blog/firecracker-vs-gvisor); [Fly.io learn](https://fly.io/learn/firecracker-vs-gvisor/)
- **gVisor security model:** the Sentry user-space kernel implements the syscall API itself, and no syscall passes straight to the host. The Sentry is pure Go (no CGo), is continuously fuzzed, and can't open files or sockets unless directfs or host networking is enabled. It does not protect against hardware side channels, and it relies on host cgroups for resource exhaustion. Specialized filesystem, network and ioctl APIs are not implemented, which is a compatibility risk for some test suites. — [gVisor security docs](https://gvisor.dev/docs/architecture_guide/security/)
- **Kata Containers** gives microVM isolation with Kubernetes pod semantics and boots more slowly than Firecracker. No exact figures were found. — [agenticwire: gVisor vs Firecracker](https://www.agenticwire.news/article/gvisor-vs-firecracker) (secondary)
- **E2B network controls:** each sandbox runs in its own Firecracker microVM. Internet is on by default and can be disabled at creation. Per-sandbox allow and deny lists take CIDRs, IPs and domains, but domain filtering works only for HTTP:80 and TLS:443; other ports are filtered by CIDR only. A denied TCP connection can appear to succeed from inside the sandbox. There is no fixed egress IP list (E2B runs on GCP), so stable IPs require your own proxy. Enterprise adds a customer-run SOCKS5 proxy (private beta) that fails closed. — [E2B internet access](https://docs.e2b.dev/network/internet-access); [E2B egress IPs](https://docs.e2b.dev/faq/egress-ip-ranges); [E2B enterprise](https://e2b.dev/enterprise.md)
- **Managed Agents cloud environment:** each session gets "its own fresh Linux container on Anthropic-managed infrastructure" with network rules and extra packages set on the environment. With a self-hosted sandbox, files and processes stay on your worker, but conversation history and tool results still go to Anthropic. You then own image hardening, egress control, environment-key rotation and session isolation. Self-hosting also gives up vault environment-variable credentials, the `github_repository` resource and the pre-installed runtimes. — [Choosing an environment](https://platform.claude.com/docs/en/managed-agents/choosing-an-environment)
- Managed Agents is not eligible for Zero Data Retention or HIPAA BAA coverage. — [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- **GitHub Actions as the runner:**
  - Fork PRs under `pull_request` get a read-only `GITHUB_TOKEN` and no other secrets.
  - `pull_request_target` runs the workflow from the default branch with secrets, so checking out and executing PR-head code (for example `make test`) is the classic compromise.
  - GitHub advises least-privilege tokens and treating PR code as data only.
  - `pull_request_target` gets read-only access to the default-branch cache, which reduces cache-poisoning risk.

  — [GitHub: securely using pull_request_target](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/securely-using-pull_request_target)

### Inferences
- **Per-run compute cost is negligible next to LLM cost.** A 5-minute verify run (install plus two test runs) on 2 vCPU / 4 GiB costs about $0.014 on E2B or Daytona, about $0.032 on Modal Sandboxes, and about $0.007 on Managed Agents runtime alone, which covers the session, not a separately sized VM. Choose on isolation, cold start, egress controls and caching, not price.
- **Recommended default:** a Firecracker-class microVM provider (E2B, or Daytona after confirming its isolation technology) with:
  1. **Egress off by default.** Allowlist only package registries (registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org, repo.maven.apache.org) through a SHAPI-run caching proxy. This also gives stable egress IPs and supply-chain logging. Remember that E2B's domain filter covers only ports 80 and 443.
  2. **No customer secrets in the sandbox.** Clone with a short-lived, read-only GitHub App installation token, then revoke or let it expire before running install scripts. Run tests with provider calls stubbed (section 1), so no provider keys are needed.
  3. **Fresh VM per job,** destroyed afterwards, with no shared writable cache across tenants.
  4. **Per-tenant dependency caches** (lockfile-hash keyed snapshots or templates). E2B templates, Daytona snapshots and Modal images support this pattern, but the specific cache APIs were not verified in this pass.
- **Customer-CI mode:** SHAPI pushes a branch and lets the customer's existing GitHub Actions workflow (`pull_request` trigger, from a same-repo branch, not a fork) run the generated test. This is the strongest trust story for security-sensitive buyers: no code leaves their infrastructure and they already trust their CI. Downsides are queue latency in minutes, dependence on customer CI health, and being able to observe results only through the Checks API. Offer it as a "bring your own runner" tier alongside the hosted sandbox.
- **Rootless Docker on SHAPI's own hosts is not adequate for multi-tenant untrusted code.** It shares the host kernel, unlike gVisor and Firecracker per the sources above. If SHAPI self-hosts, use gVisor (runsc) or Kata/Firecracker. This is inferred from the isolation-model descriptions; no source was fetched specifically on rootless Docker.
- **Managed Agents cloud environment** gives SHAPI the sandbox and the agent loop in one place at $0.08/h. Its sandbox is a container whose isolation technology is undocumented on the fetched page, and customer code plus outputs are stored server-side at Anthropic (no ZDR). For SOC2-minded customers, the self-hosted sandbox mode running workers on E2B or Firecracker may be the compromise.

### Gaps
- Cold-start figures: only Daytona's vendor claim ("sub 90ms") and Firecracker's ~125 ms were found. No primary figures for E2B, Modal Sandbox, Cloudflare Sandbox SDK or Managed Agents container start.
- Daytona's isolation technology (container vs microVM) is not stated on its pricing page.
- Cloudflare Sandbox SDK isolation and egress controls were not fetched. Containers pricing was fetched.
- Kata and rootless Docker figures: none from primary sources.
- Modal Sandbox network controls (for example `block_network`, CIDR allowlists) and secrets handling were not verified in this pass.

## LLM repair loops: verification-gated fixes, Claude integration choice, cost control, evals and fallbacks

### Takeaway
The research converges on SHAPI's own design: localize narrowly, generate a small candidate patch, and accept it only if the reproduction test now passes and existing tests still pass. Agentless showed that a fixed, non-agentic pipeline with generated reproduction tests plus regression tests is competitive and cheap (about $0.70 per issue in 2024). For SHAPI's bounded task (one call site, a known shape diff, a known failing test), a Messages API tool-use loop (or the SDK's tool runner) with a hard turn cap is the best fit. Use the Agent SDK only if SHAPI wants Claude Code's built-in file and bash tools running inside its own sandbox. Use Managed Agents if SHAPI wants Anthropic to host the loop and sandbox and can accept data-retention terms. Public SWE-bench Verified scores are saturated and contaminated, so SHAPI needs its own eval set.

### Cited Findings
- **Agentless pipeline:** localization narrows from files to classes or functions to edit locations. Repair generates many candidates (about 40 per issue) as search/replace diffs. Validation generates reproduction tests from the issue, runs the repo's existing passing tests as a regression set, and majority-votes to pick a patch. It scored 32.00% (96/300) on SWE-bench Lite at about $0.70 per issue. — [Agentless paper, arXiv 2407.01489](https://arxiv.org/html/2407.01489v2); [arXiv 2510.18270](https://arxiv.org/pdf/2510.18270)
- A later study swapping in a better localizer raised Agentless from 96 to 115 resolved (of 300) under the reproduction-test setting. Localization quality is a major lever. — [arXiv 2605.17965](https://arxiv.org/pdf/2605.17965)
- **SWE-bench Verified is no longer a reliable frontier measure.** On 2026-02-23 OpenAI said it stopped reporting it because training-data exposure drives scores and some tasks are underspecified. It recommends SWE-bench Pro instead. Decrypt reports that models above 70% on Verified score about 23% on Pro's public split, and that 59.4% of 138 audited consistently failed tasks were broken. — [OpenAI: why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/); [Decrypt](https://decrypt.co/359012/openai-benchmark-measure-ai-coding-supremacy-contaminated)
- Third-party leaderboards (as of 2026-09-09) put the top of Verified at about 96%: DeepSeek-V4-Pro-0813 96.4%, GPT-5.6 Sol 96.2%, Claude Opus 5 96%. These aggregators disagree with each other. — [BenchLM](https://benchlm.ai/benchmarks/swe-bench-verified); [aicodereview.cc](https://aicodereview.cc/blog/swe-bench-scores-leaderboard)
- **Anthropic integration options (official docs):**
  - Client SDK and Messages API: "You write the tool loop yourself, or let the client SDK's beta tool runner drive it."
  - Agent SDK: "A library that runs the Claude Code binary" in a process you operate, with built-in tools, permissions, sessions and hooks, in Python and TypeScript.
  - Managed Agents: "A hosted agent harness" with sessions in an Anthropic-managed or self-hosted sandbox.

  — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Third-party products built on the Agent SDK may not offer claude.ai login or rate limits and must use API keys. Branding may not say "Claude Code". — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Managed Agents** (beta, header `managed-agents-2026-04-01`) is "best for long-running tasks and asynchronous work". It has built-in bash, file, web and MCP tools, built-in prompt caching and compaction, and scheduled deployments. It is not ZDR or HIPAA-eligible. — [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- **Claude token pricing (fetched 2026-10-22):**

  | Model | Input / output per MTok | Cache read per MTok | Batch input / output per MTok |
  |---|---|---|---|
  | Opus 5.5 | $4 / $20 | $0.20 (0.05x input) | $2 / $10 |
  | Sonnet 5.5 | $2 / $10 | $0.10 (0.05x input) | $1 / $5 |
  | Haiku 5.5 (prompts ≤100k tokens) | $0.10 / $0.50 | $0.01 | $0.05 / $0.25 |

  - Sonnet 5's $2/$10 became the standard price; the scheduled rise to $3/$15 on 2026-09-01 "will not occur".
  - The Batch API discount is 50%.
  - US-only inference (`inference_geo`) adds a 1.1x multiplier.

  — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- **Managed Agents sessions are billed on tokens plus $0.08 per session-hour.** The Batch discount does not apply to sessions. — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing); [Verdent guide](https://verdent.ai/guides/claude-managed-agents-pricing) (secondary)
- **Effort parameter:** effort governs all output tokens: text, tool calls and arguments, and thinking. Lower effort also means fewer, terser tool calls. `xhigh` means "meaningfully higher token usage than high", and `max` "adds significant cost for relatively small quality gains". For Opus 4.7 the docs recommend `xhigh` for coding and agentic work, `high` as the floor for intelligence-sensitive work, and `medium` for cost-sensitive work. A newer page reportedly says Opus 5.5 defaults to `medium` (not cross-verified). — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)

### Inferences
- **Recommended loop for SHAPI** (deterministic-first, LLM-second, always test-gated):
  1. Try the codemod recipe. If the test passes, open the PR.
  2. If no recipe exists or the recipe fails, call Claude through the Messages API with a fixed, cached system prompt and tool definitions (recipe docs, provider changelog excerpt, shape diff) plus the localized call site and the failing test output.
  3. Expose only narrow tools (`read_file`, `apply_search_replace_edit`, `run_contract_test`, `run_repo_tests`) that execute inside the sandbox.
  4. Cap at about 3–5 iterations and a per-job token budget.
  5. Optionally sample k=3–5 candidates in parallel and pick the smallest diff that passes both the contract test and the pre-existing passing tests, in the style of Agentless majority voting.

  This is cheaper and more auditable than a free-roaming agent.
- **When to use which Anthropic surface:**
  - Messages API tool use: default. Bounded task, SHAPI owns the sandbox and loop, and it can run under ZDR if eligible.
  - Agent SDK: if SHAPI wants Claude Code's mature edit, grep and bash tools and hooks (for example, a PreToolUse hook to block network commands or edits outside the call site's files) running in SHAPI's own microVM.
  - Managed Agents: if SHAPI wants zero infrastructure for long-running or async repairs (multi-file migrations) and can accept server-side retention of customer code. Use self-hosted sandbox mode to keep files off Anthropic.
- **Cost model (inference).** A typical repair might use about 60k input tokens over 4 turns, with 50k of them cache reads, plus about 6k output tokens. On Sonnet 5.5 that is roughly 10k × $2/M + 50k × $0.10/M + 6k × $10/M ≈ $0.09 per attempt. On Opus 5.5 it is roughly $0.17. Five parallel candidates on Sonnet 5.5 cost under $0.50. Prompt caching (0.05x reads on 5.5 models) is the largest lever. Batch (50% off) suits non-urgent nightly sweeps across many repos, but not interactive flows.
- **Escalation ladder:** Haiku 5.5 to classify and localize, Sonnet 5.5 at `medium` or `high` for the patch, then Opus 5.5 at `high` or `xhigh` only after two failed Sonnet attempts.
- **Evals SHAPI should track:**
  1. Contract-test pass rate after the fix
  2. Regression pass rate (tests that passed before still pass)
  3. Diff size (lines changed, files touched) relative to the codemod or a human baseline
  4. Merge-without-edit rate on PRs
  5. Time-to-merge and revert rate within 30 days
  6. Cost and latency per fix
  7. False-fix rate: test passes but the human reviewer rejects

  Build a private, held-out benchmark from SHAPI's own mined breakage-fix commits (the repo's prior commit-mining research). Public SWE-bench numbers are contaminated per OpenAI.
- **Refusal and fallback handling:** if Claude refuses, returns no edit, exceeds the budget, or no candidate passes, SHAPI should not open a code PR. It should instead open an issue or draft PR with the failing contract test, the shape diff and the affected call sites, so the customer gets the reproducer even without a fix. Also treat "test passes only because the test was modified" as a failure: lock the test files as read-only to the model.

### Gaps
- No primary source fetched on SWE-agent's agent-computer interface findings, OpenHands or Aider's edit-format benchmarks, or Devin's verification practices.
- No published industry merge-without-edit baselines for LLM-authored PRs were found.
- The Opus 5.5 default effort level is unverified.

## How Dependabot, Renovate and code-modification companies (Codegen, Sweep, Grit, Moderne) build trust

### Takeaway
Trust comes from three things: evidence from outcomes across many repos (Renovate Merge Confidence), deterministic, reproducible transformations (OpenRewrite/Moderne recipes), and small, reviewable PRs gated by the customer's CI. SHAPI can combine all three: a deterministic recipe where possible, a contract test attached to every PR, and a confidence score built from pass rates across SHAPI's customer base for the same advisory.

### Cited Findings
- **Renovate Merge Confidence** has four badges:
  - Age: how long the release has existed
  - Adoption: share of Renovate users on this release, weighted toward organizations, private repos and projects with high test reliability
  - Passing: share of updates whose tests pass
  - Confidence: Low, Neutral, High or Very High

  The algorithm is private. The data comes from millions of PRs the Mend app has created since 2017, and the stated aim is to catch "undeclared breaking releases". npm packages under 3 days old can never get High because they can be unpublished. Very High is reserved for releases months old with high adoption or very high passing. Workflows can raise PRs only once confidence is High. — [Renovate Merge Confidence docs](https://docs.renovatebot.com/merge-confidence/)
- **OpenRewrite/Moderne** recipes operate on a Lossless Semantic Tree, a type-aware in-memory model of source code, so edits are structural, not textual. Moderne says it runs 10,000+ recipes and produces "100% accurate style-preserving" changes; treat these as vendor claims. An ICSME 2023 tool demo compared OpenRewrite against manual work and two LLMs (ChatGPT, StarChat-β) on time and accuracy; the results were not read. Moderne added Python LST support in February 2026, alongside Java and JS/TS. — [ICSME 2023 demo](https://conf.researchr.org/details/icsme-2023/icsme-2023-tool-demo-track/7/Deterministic-Automatic-Refactoring-at-Scale); [OpenRewrite README](https://cdn.jsdelivr.net/gh/openrewrite/rewrite@main/README.md); [BusinessWire Feb 2026](https://www.businesswire.com/news/home/20260219393723/en/Moderne-Expands-Agent-Tools-Platform-with-Python)
- Third-party framing: a deterministic recipe gives "the same result everywhere" but must exist for the change in question, so recipes suit well-defined upgrades, while LLM tools cover open-ended changes with shallower migration controls. — [DEV Community overview](https://dev.to/axel_6225c422a7f5ddb4eb30/ai-legacy-code-migration-in-2026-how-it-works-and-which-tools-fit-7a4)

### Inferences
- **A SHAPI "Fix Confidence" badge modelled on Renovate.** Per advisory and fix recipe, show: (a) the number of repos where the fix was applied, (b) the share where the contract test and the customer's CI passed, (c) the share merged without edits, and (d) whether the fix was produced by a deterministic recipe or by the LLM. Auto-merge only at High confidence, and only if the customer opts in.
- **PR content that builds trust:**
  - The provider changelog link
  - The old and new shape diff
  - The generated contract test, committed in the PR
  - Proof the test failed before and passes after (sandbox logs)
  - Minimal diff scoped to the affected call sites
  - A clear label distinguishing a deterministic codemod from an LLM-proposed fix
- **Use an OpenRewrite-style approach for the codemod layer:** AST-based, type-aware transforms (ts-morph or jscodeshift for TS/JS, LibCST for Python, `go/ast` or gofmt-aware rewrites for Go, OpenRewrite for Java). Promote LLM fixes that recur across customers into deterministic recipes over time.

### Gaps
- No primary sources were fetched for Codegen, Sweep or Grit trust mechanisms. Grit's GritQL and pattern approach and Sweep's PR practices remain unverified in this pass.
- Dependabot's compatibility score methodology was not fetched.
