# Static Analysis and Codemod Tooling for SHAPI (call-site extraction + automated fixes)

Research date: 2026-10-22. Research budget was about 20 tool calls, so several items below are flagged as unverified or as gaps. Where a claim comes from prior knowledge and was not re-checked in this session, it sits under Inferences or Gaps and is labeled that way, never under Cited Findings.

## Extraction engines: which give multi-language, cross-file / inter-procedural dataflow (tree-sitter, ast-grep, Semgrep OSS vs Pro, CodeQL, Joern, stack-graphs, SCIP)?

### Takeaway
No permissively licensed, SaaS-safe engine gives SHAPI mature cross-file dataflow for TS, Python, Go and Java out of the box. Semgrep Pro (commercial) and CodeQL (license-blocked for SaaS on private code) are the strongest dataflow engines. Joern (Apache-2.0) is the only open-source multi-language engine with real inter-procedural dataflow. GitHub's stack-graphs is archived. The practical stack is tree-sitter/ast-grep for multi-language syntax matching, plus per-language type and index tools (SCIP indexers, the language compilers) for cross-file resolution, with SHAPI's own lightweight dataflow on top.

### Cited Findings
**Semgrep (CE / Opengrep / Pro)**
- Semgrep Pro / Semgrep Code adds cross-function (interprocedural) analysis across functions and classes within a file, and cross-file (interfile) analysis. Cross-file analysis "accounts for information flowing between files", including cross-file taint analysis, constant propagation and type inference. It is enabled with `interfile: true` in a rule's options or with a settings toggle. — [Semgrep docs: Pro engine intro](https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro)
- Cross-file scans run only on full scans, not on diff-aware PR/MR scans. They "may take longer to complete and can use more memory than Semgrep CE scans". If pre-processing uses more than 5 GB of memory or the scan runs past 3 hours, Semgrep falls back to single-file analysis. `semgrep ci --pro-intrafile` forces single-file, cross-function mode. — [Semgrep docs: Pro engine intro](https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro)
- Known Pro limitations: some CommonJS patterns (for example, assigning a function to an export later) are not tracked, and name resolution differs from CE, so `interfile: true` rules can return different results. — [Semgrep docs: Pro engine intro](https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro)
- Semgrep Code lists "Cross-file dataflow analysis" for TypeScript, JavaScript, Python, Go and Java. — [Semgrep supported languages](https://docs.semgrep.dev/supported-languages)
- The Semgrep CE engine is LGPL-2.1, and that did not change in December 2024. The rules moved from "Commons Clause + LGPL 2.1" to the "Semgrep Rules License", which limits use to internal, non-competing, non-SaaS contexts. That license covers all Semgrep-authored rules and rules contributed to Semgrep's public repos. — [Semgrep FAQ: Semgrep CE vs Opengrep](https://docs.semgrep.dev/faq/comparisons/opengrep-1)
- Opengrep is an LGPL-2.1 fork of Semgrep CE, created in response to the December 2024 change and backed by Aikido Security, Amplify Security, Endor Labs, Mobb and others. Its backers said features such as tracking ignores, fingerprinting and some metavariable features had left the open-source engine. — [The New Stack](https://thenewstack.io/opengrep-launches-as-free-fork-after-semgrep-license-shift/); [InfoQ](https://www.infoq.com/news/2025/02/semgrep-forked-opengrep); [Arnica](https://arnica.io/blog/launching-opengrep-in-response-to-semgreps-open-source-licensing-change)
- Endor Labs benchmarked Opengrep against Semgrep and found that Opengrep's speed gains shrank as codebases grew. — [Endor Labs: benchmarking Opengrep](https://www.endorlabs.com/learn/benchmarking-opengrep-performance-improvements)

**CodeQL**
- CodeQL has deep dataflow, but the CLI license allows only academic research, demonstrations, and analysis of an "Open Source Codebase". Automated analysis, CI or CD is allowed only when that open-source codebase is hosted on GitHub.com. The terms prohibit use "in connection with any codebase that is not an Open Source Codebase (e.g., code in a private repo in GitHub)". They also prohibit providing the software "as a hosted solution". These restrictions lift only "under a paid customer license for GitHub Advanced Security". — [github/codeql-cli-binaries LICENSE.md](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md); older 2020 text at [ScanCode LicenseDB](https://scancode-licensedb.aboutcode.org/github-codeql-terms-2020.html)
- One community report says GitHub sales offered closed-source CodeQL use only through GitHub-hosted/Enterprise arrangements. This is a single user's account, not policy. — [GitHub Community thread](https://github.community/t/codeql-information/156758)

**Joern / code property graphs**
- Joern is Apache-2.0, and the codepropertygraph spec is Apache-2.0 too. It builds code property graphs and has a Scala-based query language, a dataflow overlay and a taint engine. Its docs rate language frontends as follows: C/C++ and Java Very High; JavaScript and Python High; Kotlin, PHP, Go, Swift and JVM bytecode Medium; Ruby and C# Medium-Low. — [Joern docs](https://docs.joern.io/); [Joern glossary](https://docs.joern.io/glossary/); [codepropertygraph on Scala index](https://index.scala-lang.org/shiftleftsecurity/codepropertygraph)

**GitHub stack-graphs**
- `github/stack-graphs` was archived on Sep 9, 2025. GitHub says it is "no longer supported or updated" and suggests forking it. — [Archived repo page via web.archive.org mirror](https://proxy-ga.blitzz.co/proxy/123456/web.archive.org/web/20260601045401/https:/github.com/github/stack-graphs)

**SCIP indexers**
- scip-typescript indexes at roughly 1k–5k lines of code per second, depending on the codebase, measured on a 2019 MacBook Pro. Speed is "largely bottlenecked by type checking performance", so it should be roughly as fast as running `tsc` on the codebase. This is the original announcement figure and is likely dated. — [Sourcegraph blog: announcing scip-typescript](https://sourcegraph.com/blog/announcing-scip-typescript)
- SCIP was introduced as a successor format to LSIF for precise code navigation. — [Sourcegraph blog: announcing SCIP](https://sourcegraph.com/blog/announcing-scip)
- A fork published as `@anysphere/scip-typescript` exists on npm (Anysphere is the company behind Cursor). This suggests industry use of SCIP for code-intelligence indexing. — [unpkg @anysphere/scip-typescript README](https://unpkg.com/@anysphere/scip-typescript@0.3.15/README.md)

**ast-grep / tree-sitter**
- ast-grep uses tree-sitter parsers and supports 20 or more languages (per secondary sources). One open benchmark of ast-grep, GritQL, Semgrep, jscodeshift and recast reports ast-grep at about 40 ms against about 200 ms for recast on its corpus. That result was seen only via a proxy mirror and needs verifying against the original repo. — [codemod/benchmark (mirror)](https://proxy-ga.blitzz.co/proxy/123456/github.com/codemod/benchmark)

### Inferences
- For each engine, cross-file / inter-procedural dataflow for TS, Python, Go and Java is as follows:
  - **Semgrep Pro:** yes for all four, commercial.
  - **CodeQL:** yes for all four, but effectively unusable on customer private code in a SaaS without a GHAS/enterprise deal.
  - **Joern:** yes, but quality varies. Java is strong; JS and Python are High; Go is only Medium.
  - **Semgrep CE / Opengrep:** intra-file taint only. That matches today's ts-morph prototype but adds languages.
  - **tree-sitter / ast-grep:** syntax only, no dataflow.
  - **stack-graphs:** archived, so do not build on it.
  - **SCIP:** gives cross-file symbol resolution (definitions and references), not dataflow.
- SHAPI's dataflow need is narrow: from an HTTP response object, find which fields are read, which statuses and enums are compared, and which headers are sent. A full taint engine is not required. A "local def-use chain + cross-file symbol resolution via SCIP/compiler" design probably covers 80–90% of call sites at far lower cost and license risk than Semgrep Pro or CodeQL. This is an inference, not measured.
- Semgrep's 5 GB / 3 h fallback and its full-scan-only cross-file mode suggest cross-file dataflow over customer monorepos is expensive. SHAPI should plan for incremental, per-package analysis.
- Recommended extraction stack:
  1. tree-sitter (via ast-grep's Rust or napi bindings) as the universal parser and pattern layer for call-site discovery in all languages.
  2. Per-language "precise" passes for receiver and type resolution: the TS compiler API / ts-morph, which is already in place, then Pyright for Python, go/packages + go/types for Go, and javac or JavaParser for Java. Optionally, SCIP indexers emit cross-file symbol graphs in one common format.
  3. Joern as an optional Apache-2.0 backend for deeper Java/JS/Python inter-procedural flows.
  4. Use Opengrep (LGPL, run as a subprocess) only with SHAPI-authored rules, because Semgrep registry rules are barred from SaaS use.

### Gaps
- Not confirmed from primary docs: whether Semgrep CE / Opengrep do any cross-function taint, rather than purely intraprocedural. Prior knowledge says CE is intraprocedural only.
- No monorepo-scale benchmarks found for Joern, ast-grep (rewrite throughput), Semgrep Pro interfile, or CodeQL database build times. The scip-typescript 1k–5k LOC/s figure is the only published number, and it dates from about 2022.
- scip-python, scip-go and scip-java maintenance status and throughput were not verified this session.
- Opengrep's 2026 status (releases, whether it added cross-file analysis) was not verified.
- ast-grep's license was not re-verified this session (prior knowledge: MIT).

## Can type information (TS compiler API, Pyright, gopls) be used cheaply to resolve SDK receivers and response types? Tradeoffs vs syntax-only

### Takeaway
Type-aware resolution costs roughly the same as type-checking the repo, which is usually minutes, not hours, for TS. It is the only reliable way to tell that `client.repos.get()` is Octokit, or that a variable holds a Stripe `Invoice`. Run syntax-only matching first and add type passes per language. Accept degraded results when a repo won't build (missing deps, private registries).

### Cited Findings
- scip-typescript's indexing speed (1k–5k LOC/s) is bottlenecked by TypeScript type checking, and is about the same as running `tsc`. — [Sourcegraph blog](https://sourcegraph.com/blog/announcing-scip-typescript)
- OpenRewrite's LSTs carry type attribution "even when a referenced symbol is defined in another file or project". The canonical example is that `logger.info("Hi")` cannot be classified as SLF4J vs Logback without types. This is the same problem as telling which SDK a receiver belongs to. — [OpenRewrite: Lossless Semantic Trees](https://docs.openrewrite.org/concepts-and-explanations/lossless-semantic-trees)
- Moderne markets its October 2025 JS/TS support as "the first type-attributed JavaScript & TypeScript refactoring", which shows that type attribution is the key differentiator in commercial codemod tools. — [BusinessWire, Oct 14 2025](https://www.businesswire.com/news/home/20251014739134/en/Moderne-Expands-Modernization-Platform-With-First-Type-Attributed-JavaScript-TypeScript-Refactoring)
- Semgrep Pro's cross-file mode includes "type inference" as a feature, which shows that even pattern engines need types for accuracy. — [Semgrep docs](https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro)

### Inferences
- The tradeoffs between the two approaches:
  - **Syntax-only (tree-sitter/ast-grep):** fast (milliseconds per file), needs no build or dependency install, and never fails. However, it misses aliased imports, wrappers such as `const gh = new Octokit(); export default gh`, and DI-injected clients, and it cannot know response types.
  - **Type-aware:** needs `node_modules` / virtualenv / Go module downloads, so sandboxed dependency installs from customer repos add cost and security exposure. Cost scales with `tsc` / Pyright / `go build` time.
- Recommended tiering:
  - **Tier 0:** syntax heuristics on import names plus constructor patterns (cheap, all repos).
  - **Tier 1:** type resolution only for files with candidate call sites, using the TS LanguageService on a project subset, Pyright in library mode with stubs, and go/types via `golang.org/x/tools/go/packages`.
  - **Tier 2:** cached SCIP indexes for cross-file references.
- For SDK response types, provider SDKs ship typed definitions: Octokit has `@octokit/types`, stripe-node bundles TS types, and stripe-python has typed resources. With type info, SHAPI can map field accesses to schema fields precisely, which is high value for "rename field x to y" recipes.

### Gaps
- No published numbers found for Pyright or gopls throughput on large repos, or for incremental re-analysis cost.
- Not researched: the license and embedding status of Pyright (prior knowledge: MIT) and gopls/x/tools (BSD-3), or how other SaaS vendors handle sandboxing dependency installs.

## Codemod engines: formatting/comment preservation and multi-language rule formats

### Takeaway
Two engines give one rule format across many languages: ast-grep, with tree-sitter-based YAML rules and rewrite/fix, and GritQL (MIT, still public after Honeycomb's April 2025 acquisition but with uncertain maintenance). Comby and Semgrep autofix are weaker multi-language options. Type-aware, format-preserving engines are per-language: ts-morph/jscodeshift (JS/TS), LibCST (Python), OpenRewrite (Java/Kotlin, and JS/TS only under Moderne's source-available license), Rector (PHP), and go/ast with gopls (Go). Bowler is effectively deprecated in favor of LibCST.

### Cited Findings
- **OpenRewrite:**
  - LSTs are "format-preserving": whitespace is retained so code prints back exactly, and inserted code matches local style. The page does not explicitly describe comment handling. — [OpenRewrite LST docs](https://docs.openrewrite.org/concepts-and-explanations/lossless-semantic-trees)
  - The `rewriteTest` framework adds checks beyond visible code, such as type validation of LST elements. It intentionally has no option to ignore formatting or import differences. — [OpenRewrite FAQ](https://docs.openrewrite.org/reference/faq)
- **OpenRewrite JS/TS:** the core framework is Apache-2.0. Running JS recipes requires the Moderne CLI. Recipes are marked as under the Moderne Source Available License (MSAL). The Moderne CLI is free for open-source repos, but closed-source repos need a license. The standalone `openrewrite/rewrite-javascript` repo was archived on May 12, 2025, and JS support moved into the main rewrite repo. — [openrewrite/rewrite-javascript](https://github.com/openrewrite/rewrite-javascript); [OpenRewrite JS recipe dev environment](https://docs.openrewrite.org/authoring-recipes/javascript-recipe-development-environment); [Moderne CLI JS guide](https://docs.moderne.io/user-documentation/moderne-cli/how-to-guides/javascript); [BusinessWire Oct 2025](https://www.businesswire.com/news/home/20251014739134/en/Moderne-Expands-Modernization-Platform-With-First-Type-Attributed-JavaScript-TypeScript-Refactoring)
- **GritQL:**
  - MIT-licensed. The README lists JS/TS, Python, JSON, Java, Terraform, Solidity, CSS, Markdown, YAML, Rust, Go and SQL. The repo is public and not archived (384 commits, 26 open PRs, 115 issues, no tagged releases shown, no mention of Honeycomb). — [getgrit/gritql](https://github.com/getgrit/gritql)
  - Honeycomb acquired Grit on April 10, 2025. Founder Morgante Pell joined Honeycomb to lead AI features, and Honeycomb said it would use Grit for custom instrumentation. — [Honeycomb blog](https://www.honeycomb.io/blog/honeycomb-acquires-grit-and-expands-leadership-team-to-accelerate-customer-value-and-enterprise); [Pulse 2.0](https://pulse2.com/honeycomb-buying-query-system-and-ai-agent-company-grit)
- **Codemod.com:**
  - Open-source CLI to "scaffold, share, and run multi-step transformations". It has first-class ast-grep support and "jssg" (JavaScript ast-grep: write AST transformations in TypeScript with pattern matching and semantic analysis), plus YAML workflows, a registry and MCP tools. — [codemod/codemod GitHub](https://github.com/codemod/codemod); [Codemod jssg docs mirror](https://backiee.wasmer.app/https_docs_codemod_com/jssg/advanced)
  - "Butterflow" is described as a self-hostable workflow engine for multi-step, multi-repo transformations. — [Codemod docs mirror](https://backiee.wasmer.app/https_docs_codemod_com/jssg/advanced)
  - The Node.js project's userland-migrations effort uses codemods built on this ecosystem. — [nodejs/userland-migrations docs](https://www.mintlify.com/nodejs/userland-migrations/concepts/how-codemods-work)
- **Bowler / Python:**
  - Bowler 0.x is built on fissix, a lib2to3 fork, and its own README now recommends LibCST for codemods. A LibCST-based Bowler 2.x never shipped, and package scanners flag Bowler as stale. — [PyPI bowler](https://pypi.org/p/bowler); [Meterian](https://www.meterian.io/components/python/bowler)
  - Facebook's older regex `codemod` tool is in `facebookarchive`, with its last commit in November 2020. — [goodfirstissue listing](https://www.goodfirstissue.org/facebookarchive/codemod)

### Inferences
These come from prior knowledge, not re-verified this session; verify before relying on them.

| Engine | Languages | Preserves formatting/comments | Type-aware | License (unverified unless cited) | Fit for SHAPI recipes |
|---|---|---|---|---|---|
| ast-grep (YAML `rule` + `fix`/`rewrite`/`transform`) | 20+ via tree-sitter | Yes: text-splice rewrites leave untouched code byte-identical | No | MIT (unverified) | Best universal fixer for "accept 200 as well as 204", "bump version string", simple renames |
| GritQL | ~12 listed | Yes (text-splice) | Limited | MIT ([cited](https://github.com/getgrit/gritql)) | Good, but maintenance risk post-acquisition |
| Comby | Language-agnostic (structural, balanced delimiters) | Yes (text-splice) | No | Apache-2.0 (unverified) | Fallback for languages without tree-sitter grammars; appears low-activity (unverified) |
| Semgrep / Opengrep `fix:` | 30+ | Mostly text-splice | Pro only | LGPL engine | OK, but rule-license issues; weaker than ast-grep for rewriting |
| ts-morph / TS compiler | TS/JS | Mostly yes for targeted node edits; reprinting full nodes can lose formatting | Yes | MIT (unverified) | Keep for type-dependent TS recipes (field renames on typed responses) |
| jscodeshift (recast) | JS/TS | Yes: recast reprints only modified nodes | No | MIT (unverified) | Mature, but ts-morph/ast-grep cover it |
| LibCST | Python | Yes: concrete syntax tree, lossless | Optional metadata providers (scope, qualified names; Pyre/Pyright-based type inference) | MIT (unverified) | Standard choice for Python |
| OpenRewrite | Java/Kotlin/Groovy/YAML/XML; JS/TS via Moderne | Yes (LST, cited) | Yes | Apache core; MSAL for JS/TS and many recipes (cited) | Best for Java, but licensing makes closed-source customer use paid |
| Rector | PHP | Yes, via format-preserving printer | Yes, via PHPStan | MIT (unverified) | Only if PHP customers appear |
| go/ast + gofmt, gopls/`gorename`-style, `go fix`/`gofix`, `eg` | Go | gofmt re-normalizes formatting, which is acceptable in Go culture; comments can drift with go/ast edits | Yes, via go/types | BSD-3 (unverified) | Use ast-grep for syntax edits; go/types for verification |

- Recommendation: make ast-grep the primary fixer format (one YAML recipe schema across languages, byte-preserving edits). Use per-language "precise" fixers only for type-dependent recipes: ts-morph (TS), LibCST (Python), go/ast plus gofmt (Go), and JavaParser/OpenRewrite-OSS (Java). Avoid making GritQL or OpenRewrite-JS a core dependency, because of acquisition and licensing risk.

### Gaps
- Not verified: ast-grep, Comby and LibCST current release cadence and licenses; whether GritQL has had commits since the acquisition (the commit date was not visible); whether Comby is still maintained.
- No primary-source data on comment-preservation edge cases for each engine.

## How do Moderne/OpenRewrite and Grit/Codemod.com run recipes across thousands of repos safely?

### Takeaway
Moderne's model rests on four things: build and serialize type-attributed LSTs once per repo, run declarative and tested recipes against the cached LSTs in parallel, emit data tables and diffs (dry run), then let humans or automation commit or open PRs. Codemod.com offers an open-source analog: multi-step YAML workflows (Butterflow) with an ast-grep/jssg engine and a registry. SHAPI should copy this shape: cached per-repo index, recipe unit tests with before/after fixtures, a dry-run diff stage, and staged PR rollout.

### Cited Findings
- Locally, OpenRewrite builds the LST in memory from files on disk, applies changes, writes changed files, and discards the LST, so the LST must fit in memory. Moderne instead builds and processes LSTs in pieces. — [OpenRewrite LST docs](https://docs.openrewrite.org/concepts-and-explanations/lossless-semantic-trees)
- The Moderne CLI serializes LSTs so a whole repo need not be in memory, builds LSTs in pieces for oversized repos, runs recipes against multiple repositories at once, and can use precomputed LSTs to speed up runs. The Moderne Platform adds data tables. Plain OSS Maven/Gradle runs produce a summary of changed files, with data tables giving more detail. — [OpenRewrite FAQ](https://docs.openrewrite.org/reference/faq)
- Recipe testing: `rewriteTest` validates before/after source plus LST type attribution, with no option to ignore formatting or import differences. That makes formatting regressions test failures. — [OpenRewrite FAQ](https://docs.openrewrite.org/reference/faq)
- Codemod.com: multi-step workflows in YAML, a registry for sharing codemods, MCP tools, and a self-hostable workflow engine (Butterflow) for orchestrating transformations across repositories. — [codemod/codemod](https://github.com/codemod/codemod); [Codemod docs mirror](https://backiee.wasmer.app/https_docs_codemod_com/jssg/advanced)

### Inferences
- Proposed SHAPI rollout pipeline, mirroring the Moderne model:
  1. Build a per-repo index (call sites plus types) and cache it, keyed by commit SHA.
  2. Recipes are declarative (ast-grep YAML plus optional precise step), each with fixture-based before/after tests and "must not change" negative fixtures.
  3. Dry-run across all affected repos, producing diffs and a data table of matched/changed/skipped sites with reasons.
  4. Run post-fix checks: parse/compile/type-check, and the repo's tests if available.
  5. Do staged rollout (internal repos, then design partners, then everyone), with per-recipe kill switches and PR-merge-rate tracking.
  6. Make PRs idempotent: re-running a recipe on fixed code yields no diff.
- OpenRewrite's "fail the test on any formatting diff" stance is worth adopting. Customers judge bot PRs harshly on noisy diffs.

### Gaps
- Not found: Moderne's published numbers (repos per hour, LST build cost); details of `rewrite:dryRun` patch output (not on the pages fetched, though prior knowledge says it writes a `rewrite.patch` file); Grit's pre-acquisition multi-repo "migrations" product details; Codemod.com pricing and whether its hosted platform is still sold in 2026.

## Licensing gotchas for a commercial SaaS that analyzes customer code

### Takeaway
The two big traps are CodeQL (prohibited on non-open-source code and as a hosted solution without GHAS) and Semgrep's rules, which are barred from SaaS/competing use even though the LGPL engine is usable. Moderne's MSAL covers OpenRewrite JS/TS and many recipes and needs a paid license for closed-source code. Joern, GritQL and (reportedly) ast-grep, LibCST and tree-sitter are permissive.

### Cited Findings
- **CodeQL:** prohibited "in connection with any codebase that is not an Open Source Codebase", for automated analysis/CI/CD outside the open-source-on-GitHub.com case, and as "a hosted solution". The exception is a paid GitHub Advanced Security license. The current LICENSE.md shows no effective date. — [codeql-cli-binaries LICENSE.md](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md)
- **Semgrep:** engine LGPL-2.1, but the Semgrep Rules License limits Semgrep-authored and community-contributed registry rules to internal, non-competing, non-SaaS use. — [Semgrep FAQ](https://docs.semgrep.dev/faq/comparisons/opengrep-1)
- **Semgrep pricing (current page):**
  - Free Edition: up to 10 contributors and 10 private repos, and includes "cross-file analysis with Pro rules".
  - Teams: from $30 per contributor per month per module (Code $30, Supply Chain $30, Secrets $15), up to 500 private repos.
  - Enterprise: custom pricing.
  - These are seat-based plans for scanning your own code, not a license to embed in a SaaS. — [Semgrep pricing](https://semgrep.dev/pricing)
- **Moderne:** JS/TS support and many recipes are under MSAL. The Moderne CLI is free for open-source repos, and closed-source repos need a license. — [rewrite-javascript README](https://github.com/openrewrite/rewrite-javascript); [Moderne press release](https://www.businesswire.com/news/home/20251014739134/en/Moderne-Expands-Modernization-Platform-With-First-Type-Attributed-JavaScript-TypeScript-Refactoring)
- **Permissive options:** Joern and codepropertygraph are Apache-2.0 ([Scala index](https://index.scala-lang.org/shiftleftsecurity/codepropertygraph); [Joern docs](https://docs.joern.io/)), and GritQL is MIT ([GitHub](https://github.com/getgrit/gritql)).

### Inferences
- Do not use CodeQL in SHAPI's hosted pipeline on customer private repos. A customer running CodeQL under their own GHAS license on their own infra (customer-run CI action) is a different and possibly permissible arrangement; this needs a legal read.
- Opengrep or Semgrep CE as a subprocess with SHAPI-authored rules is low-risk under LGPL-2.1: no static linking and no modification distributed. Never ship Semgrep registry rules, and do not depend on Semgrep Pro / AppSec Platform terms for embedding without a commercial agreement.
- MSAL text was not read in this session. Assume OpenRewrite JS/TS and MSAL recipes cannot run inside SHAPI's SaaS on customer closed-source code without a Moderne deal. Apache-2.0 OpenRewrite core plus Java parsers are fine.
- Other components (from prior knowledge, unverified): tree-sitter core and most grammars are MIT; Pyright is MIT; TypeScript is Apache-2.0; LibCST is MIT; Go x/tools is BSD-3. Some third-party tree-sitter grammars carry other licenses, so audit each grammar.
- Contract-level gotcha regardless of tool license: customer agreements will govern code retention. Caching indexes or LSTs, as Moderne does, means storing derived customer code, so it needs DPA/SOC 2 coverage.

### Gaps
- MSAL full text and the exact SaaS/hosting restrictions were not fetched.
- Semgrep's AppSec Platform terms for third-party/SaaS embedding were not fetched.
- No primary source found on whether GitHub sells a CodeQL license specifically for vendor SaaS use on third-party private code.
- Comby, ast-grep and LibCST licenses were not re-verified this session.
