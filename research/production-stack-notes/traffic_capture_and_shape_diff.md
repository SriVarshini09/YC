# Traffic capture and shape inference/diff for SHAPI (egress observation of third-party APIs)

Research date: 2026-10-22. Scope: how to observe customers' outbound (egress) traffic to third-party APIs with strong privacy guarantees, and which schema-inference/diff tooling to adopt. Roughly 25 searches/fetches. Vendor claims are marked as such.

## Q1. Egress HTTP capture options: OTel SDK instrumentation, OTel Collector, eBPF, proxies, SDK middleware

### Takeaway
None of the standard OpenTelemetry HTTP client instrumentations capture response bodies; HTTP bodies are deliberately outside the OTel semantic conventions, so OTel alone gives SHAPI status codes, headers, URLs and sizes but no field-level shape. Body-level shape capture needs either (a) an in-process client hook/middleware that reads the body and emits a shape (not values) as a span attribute/log, (b) eBPF uprobes on TLS libraries (Linux only, root/CAP_BPF, fragile for Go and statically linked binaries), or (c) a forward proxy with TLS interception (most invasive). For SHAPI's "minimal setup + privacy" goal, an in-process shape-extracting hook shipped as OTel-compatible packages (Node undici/fetch, Python httpx/requests, Go RoundTripper, Java OkHttp interceptor) is the best primary path, with the OTel Collector redaction processor as a fail-closed safety net and an eBPF agent (OBI/Beyla-style, or Postman Insights Agent-style) as an optional zero-code path for Linux/Kubernetes.

### Cited Findings
**OpenTelemetry SDK instrumentation (metadata only by design)**
- Request and response bodies are not part of the OTel HTTP semantic conventions; the suggested workaround is custom extractors or injecting the data manually — [Quarkus discussion #31663](https://github.com/quarkusio/quarkus/discussions/31663)
- OTel spec issue #1284 ("Modelling HTTP client response body capture") notes the client span is usually finished before the body is read, and the OTel design does not appear to pursue body capture; it links to semantic-conventions issue #857 — [opentelemetry-specification #1284](https://github.com/open-telemetry/opentelemetry-specification/issues/1284)
- The OTel Java agent supports capturing configured request/response headers (capture-request-headers / capture-response-headers properties) and, as experimental telemetry, only `http.request.body.size` and `http.response.body.size` (sizes, not content) — [OTel Java agent HTTP instrumentation config](https://opentelemetry.io/docs/zero-code/java/agent/instrumentation/http/)
- Node `@opentelemetry/instrumentation-undici` (covers undici and Node's global fetch) exposes a `responseHook` that runs once response headers arrive, intended for adding custom attributes; spans start on the `undici:request:create` diagnostics channel and end on `undici:request:trailers` — [instrumentation-undici README](https://unpkg.com/@opentelemetry/instrumentation-undici@0.30.0/README.md)
- `opentelemetry-instrumentation-httpx` documents instrumenting all clients, single clients, and custom transports; no body-capture hook is documented — [PyPI opentelemetry-instrumentation-httpx](https://pypi.org/project/opentelemetry-instrumentation-httpx/0.46b0)
- A third-party write-up argues OTel excludes bodies from default instrumentation because of unbounded size, frequent PII and performance cost (third-party view, not official) — [Last9 .NET body capture with PHI redaction](https://last9.io/blog/dotnet-http-body-capture-otel.md)

**OTel Collector processors (edge redaction/shaping)**
- The `redactionprocessor` (contrib and k8s distributions) is beta for traces, alpha for logs and metrics. It deletes attributes not on `allowed_keys` ("designed to fail closed"; empty list removes everything), masks values matching `blocked_values` / `blocked_key_patterns`, supports `allowed_values`, `ignored_keys`/`ignored_key_patterns`, `allow_all_keys`, and audit `summary` levels (debug/info/silent) — [redactionprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)
- It can replace masked values with a hash: md5, sha1, sha3 (SHA-256), hmac-sha256, hmac-sha512; HMAC is recommended for low-entropy data (e.g., IPs) and the HMAC key can come from an env var — [redactionprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)
- It has a `url_sanitizer` that strips variable URL parts (IDs, timestamps) to reduce cardinality (span-name sanitization on by default) and a `db_sanitizer` (SQL, Redis, Memcached, MongoDB, OpenSearch, Elasticsearch) that removes literals while keeping query structure — [redactionprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)

**eBPF agents and TLS visibility**
- Grafana Beyla: zero-code trace spans and RED metrics for Linux HTTP/S and gRPC services, exported in OTel format and Prometheus; requires Linux kernel 5.8+ with BTF (5.17+ for header-based context propagation; RHEL 8 4.18 supported), admin privileges; Go apps must be built with Go 1.17+; claims no memory/CPU/IO/locking overhead on the app since it runs out of process. The docs page does not state that it captures HTTP payloads — [Beyla docs](https://grafana.com/docs/beyla/latest/)
- Grafana donated Beyla to OpenTelemetry in 2025 as "OpenTelemetry eBPF Instrumentation" (OBI), initial code drop announced at GrafanaCON 2025 — [Grafana blog, May 2025](https://grafana.com/blog/2025/05/07/opentelemetry-ebpf-instrumentation-beyla-donation/)
- Beyla is now Grafana's distribution of upstream OBI; Beyla 2.5 was the first release to vendor most code from the OBI repo; not every Beyla feature is in OBI yet and Beyla releases faster — [Grafana blog, Aug 2025](https://grafana.com/blog/2025/08/04/building-on-the-foundation-of-opentelemetry-ebpf-instrumentation-what-s-new-in-grafana-beyla-2-5/); [Beyla OBI docs](https://grafana.com/docs/beyla/latest/obi/)
- Pixie: basic protocol tracing probes network syscalls; TLS tracing places uprobes on the TLS library API so data is read before encryption — [Pixie eBPF docs](https://docs.px.dev/about-pixie/pixie-ebpf/)
- Pixie lists full-body protocol traces for HTTP; OpenSSL 1.1.0, 1.1.1 and 3.x supported when dynamically linked; Go gRPC/HTTP2 works with or without TLS but Go apps need debug information — [Pixie data sources](https://docs.px.dev/about-pixie/data-sources/)
- A 2022 New Relic note lists Go crypto/tls among Pixie's supported TLS libraries (older source) — [New Relic what's new, Nov 2022](https://docs.newrelic.com/whats-new/2022/11/whats-new-11-09-pixie-protocols/)
- Pixie's LPC 2021 paper explains kprobe/syscall tracing struggles with TLS and HTTP/2, motivating uprobes — [LPC 2021](https://linuxplumbersconf.org/event/11/contributions/945/)
- General uprobe constraints (Kubeshark docs): OpenSSL hooks on `SSL_read`/`SSL_write` cover Python, Java, PHP, Ruby, Node; Go needs probes on `crypto/tls.(*Conn).Read/Write`, uretprobes don't work with Go's ABI (requires disassembling to find return instructions), Go's two ABIs complicate offsets, and the method works only on non-stripped binaries — [Kubeshark encrypted traffic](https://docs.kubeshark.com/en/encrypted_traffic)
- Example of the limitation in a small tool: an OpenSSL-uprobe-only tool states Go crypto/tls stays invisible to it — [tinytap](https://pkg.go.dev/github.com/shinagawa-web/tinytap)
- Keploy: egress interceptor redirects outbound TCP (and some UDP) to a local proxy that records/mocks it; covered protocols HTTP, gRPC, PostgreSQL, MySQL, MongoDB, Redis, Kafka — [How Keploy works](https://keploy.io/docs/keploy-explained/how-keploy-works/); outbound calls are recorded at byte level into YAML test cases with mocks and replayed with a frozen clock — [What is Keploy eBPF](https://keploy.io/docs/concepts/what-is-keploy-ebpf/)
- Keploy TLS: its architecture docs describe interception via a fake certificate chain inserted between app and Keploy (method varies by runtime), while a Keploy blog on eBPF TLS tracing says eBPF avoids fake certificates — sources are inconsistent — [How Keploy works](https://keploy.io/docs/keploy-explained/how-keploy-works/); contradicted in spirit by [Keploy eBPF TLS blog](https://dev.to/keploy/ebpf-for-tls-traffic-tracing-secure-efficient-observability-3n3f)

**Proxies**
- Envoy HTTP tap filter is explicitly experimental (config may change); captures request/response headers and bodies, buffering 1 KiB of each body per trace by default (`max_buffered_rx_bytes`/`max_buffered_tx_bytes` to raise); sinks `streaming_admin`, `buffered_admin`, `file_per_tap`; JSON with base64 bodies by default; sampling via `tap_enabled`; body pattern matching is CPU intensive — [Envoy tap filter docs](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/tap_filter)

**SDK/client middleware (precedent from vendors)**
- Treblle SDK masking runs inside the SDK before data leaves the server, matches field names in request/response headers and bodies at any depth, and replaces values with same-length asterisks; option names differ across SDKs (`maskedKeywords` replaces defaults; `additionalFieldsToMask` adds); middleware must be registered after body parsing — [Treblle data masking](https://docs.treblle.com/treblle/data-masking/); [Treblle masking fields](https://docs.treblle.com/security/masking); [treblle npm README](https://cdn.jsdelivr.net/npm/treblle@3.0.0/README.md)

### Inferences
- For SHAPI the "shape" (paths, types, value classes) must be computed where the body is visible. In-process hooks are the only portable, cross-OS, TLS-agnostic way to do that. Practical implementation per runtime: Node = subscribe to undici `diagnostics_channel` / wrap `fetch` and clone the response; Python = httpx custom transport or event hooks, requests `Session` hooks / urllib3 response wrapper; Go = wrapping `http.RoundTripper` (the same pattern otelhttp uses); Java = OkHttp `Interceptor` / Apache HttpClient `ResponseInterceptor`. Emit the shape as a span event or log record attribute so it rides existing OTel pipelines. (Inference; API-level details from general knowledge, not verified in this session.)
- Only observe hosts on an allowlist of known third-party API domains (api.github.com, api.stripe.com, quickbooks.api.intuit.com, ...). This bounds overhead and reduces the privacy blast radius.
- Overhead risk: reading/cloning response bodies in-process doubles buffering for large or streamed responses; cap at N KB, sample per endpoint (e.g., first K per hour per endpoint+status), and skip non-JSON content types.
- eBPF is attractive for "zero code" but carries Linux-only, privileged (CAP_BPF/CAP_PERFMON/SYS_ADMIN), kernel-version and Go-symbol constraints; it is a poor fit for serverless (Lambda, Cloud Run, Vercel), which many SaaS integrators use. Beyla/OBI emit metrics/traces, not payloads, so for body shapes SHAPI would need Pixie-style or Postman-agent-style payload uprobes.
- Forward proxies with TLS interception (mitmproxy, Squid ssl-bump) require installing a CA into every client trust store — the highest-friction, most security-sensitive option; Envoy tap is only practical where a mesh/egress gateway already terminates TLS (e.g., Istio egress gateway with TLS origination).

### Gaps
- Did not verify current Odigos or Cilium Hubble payload capabilities (Hubble L7 visibility is understood to require Envoy proxying for HTTP and to show method/path/status, not bodies — unverified here).
- Did not verify mitmproxy/Squid details or OTel Go `otelhttp` / Python `requests`/`urllib3` hook signatures this session.
- Could not confirm whether OBI (the OpenTelemetry project) has added any payload/body extraction as of Oct 2026.
- No benchmark numbers found for in-process body-shape extraction overhead.

## Q2. How API-observability vendors inferred specs from traffic, and lessons on adoption friction and privacy

### Takeaway
Akita (now Postman Insights) is the closest precedent: passive capture via libpcap plus opt-in eBPF uprobes for HTTPS, with data-format inference done client-side and all values stripped before upload by default. Its trajectory (acquired by Postman in 2023; agent still "alpha" focused on ECS) suggests that passive network capture works technically but has real deployment friction. Optic (spec-from-test-traffic and diffing) was acquired by Atlassian in April 2024 and its repo was archived in January 2026. Noname was acquired by Akamai (June 2024). Security vendors (Levo, Salt, Noname) push "edge sensors that strip payloads at the source" as the privacy story.

### Cited Findings
**Akita -> Postman Insights**
- Postman announced the Akita acquisition on 19 July 2023, its first strategic acquisition — [BusinessWire, Jul 2023](https://www.businesswire.com/news/home/20230719991128/en/Postman-Acquires-Akita-Software-to-Help-Build-the-Future-of-API-Observability)
- Postman's CEO described the approach as scanning production environments with eBPF to build an API inventory in a low-touch, non-intrusive way — [TechTarget](https://techtarget.com/searchsoftwarequality/news/366545314/Postman-API-platform-will-use-Akita-to-tame-rogue-endpoints)
- A third-party directory says Akita discovered and monitored APIs by watching traffic without frameworks or SDKs, and its agent is now the open-source Postman Insights Agent; it dates the close to November 2023 (aggregator source) — [apis.io Akita](https://apis.io/providers/akita-software/)
- Postman Insights Agent captures plaintext HTTP with classic BPF via libpcap; decrypted HTTPS via eBPF uprobes on TLS libraries only with opt-in `--enable-https-capture`; HTTPS capture is Linux-only (kernel 5.8+ or RHEL 8 backport), needs CAP_BPF and CAP_PERFMON (or CAP_SYS_ADMIN), `/sys/kernel/debug`, `/sys/fs/bpf` and host `/proc`; macOS captures HTTP only; README describes the release as alpha supporting Amazon ECS; the open-source community build omits type and data-format inference (only in the distributed binary) — [postman-insights-agent repo](https://github.com/postmanlabs/postman-insights-agent)
- With Repro Mode off, the agent strips data values on the client before upload: query parameters, request/response headers, and values (but not identifiers) in JSON/YAML bodies; "All data-format inference happens on the client side, before the data is removed" — [Postman Insights repro mode security](https://learning.postman.com/latest-v-12/docs/insights/data/repro-mode-security)
- With Repro Mode on, payloads for 4xx/5xx responses are kept; a built-in sensitive-keyword list redacts matching headers/query/body portions to `*REDACTED*`; Postman warns unrecognized sensitive data may be sent and stored for up to 30 days, and redaction setting changes are not retroactive — [Postman Insights repro mode security](https://learning.postman.com/latest-v-12/docs/insights/data/repro-mode-security)
- Default sensitive key names (case-insensitive) include accessToken, api-key, api_key, auth, clientSecret, password, proxy-authorization, secretKey, sessionToken, set-cookie, token, x-api-key, x-auth-token, x-csrf-token, etc.; about 100 default value regexes (PMAK- keys, AWS AKIA keys, Google AIza keys, JWTs `eyJhbGciOi`, Bearer/Basic values, PEM private keys); optional editable regexes for US SSN, phone, email and card numbers — [Postman Insights redactions](https://learning.postman.com/docs/insights/data/redactions)

**Optic -> Atlassian**
- Atlassian acquired Optic (API docs and breaking-change prevention) to integrate into Compass — [Atlassian blog](https://www.atlassian.com/blog/announcements/optic-acquisition); PitchBook dates the deal 25 Apr 2024, ~10 employees, ~$5.5M raised — [PitchBook](https://pitchbook.com/profiles/company/232093-63); listed in Atlassian Q3 FY24 results — [Atlassian shareholder letter Q3 FY24](https://www.atlassian.com/blog/company-news/shareholder-letter-q3fy24)
- The opticdev/optic GitHub repo was archived (read-only) on 12 Jan 2026; MIT licensed; described as "OpenAPI linting, diffing and testing", generating OpenAPI from test traffic, and catching breaking changes — [opticdev/optic](https://github.com/opticdev/optic)

**Noname -> Akamai; Levo; Speakeasy; Treblle**
- Akamai announced the Noname acquisition 7 May 2024 (~$450M) and completed it 25 June 2024; Akamai had earlier bought Neosec and acknowledged product overlap — [Akamai press release](https://www.akamai.com/newsroom/press-release/akamai-completes-acquisition-of-api-security-company-noname); [Dark Reading](https://www.darkreading.com/cloud-security/akamai-completes-acquisition-of-api-security-company-noname); [SDxCentral](https://www.sdxcentral.com/articles/interview/akamai-doubles-down-on-api-security-with-noname-acquisition/2024/06/)
- Levo (vendor claim): eBPF edge sensors strip sensitive payloads at the source and "no PII, PHI or credit-card data ever leaves your environment" — [Levo G2 seller page](https://www.g2.com/sellers/levo-fed6d6f5-ba0b-4b0c-9a31-6bfb424af86c); a third-party comparison describes a "satellite" for local schema and sensitive-data processing that customers can host on-prem/hybrid, alongside a SaaS catalog — [rfp.wiki Akto vs Levo](https://www.rfp.wiki/it-security/application-security-testing/api-protection/akto/levo-ai)
- Speakeasy previously captured API traffic (2022 changelog mentions sharing filtered traffic and a fix for generating OpenAPI schemas from traffic stored in BigQuery in self-hosted GCP deployments) — [Speakeasy changelog 2022-09-13](https://www.speakeasy.com/changelog/changelog-2022-09-13)
- Treblle uses in-app SDK middleware with in-SDK masking (see Q1) — [Treblle data masking](https://docs.treblle.com/treblle/data-masking/)

### Inferences
- The Akita/Postman design ("infer formats client-side, strip values, upload shapes") is essentially SHAPI's proposed privacy model and is a credible, citable precedent for customers' security reviews.
- Akita's agent being still "alpha" focused on ECS years after acquisition, and HTTPS capture being opt-in with heavy privileges, suggests passive network capture has meaningful adoption friction (privileged DaemonSets, kernel constraints, security review). SHAPI should not make eBPF its primary path.
- Speakeasy appears to have pivoted from traffic capture to SDK generation (inferred from its current product focus; the 2022 changelog is the only traffic-capture evidence found). Optic's archival and Akita's absorption indicate standalone "spec from traffic" businesses struggled to stand alone; SHAPI differentiates by focusing on third-party (egress) APIs and cross-customer aggregation rather than first-party spec generation.

### Gaps
- Could not retrieve Akita's own engineering blog posts on adoption lessons (console.dev interview URL returned 404; Akita blog not indexed).
- No current (2026) primary sources on Salt Security's traffic-ingestion model or status; APIsec is primarily an API security testing product and no traffic-inference details were found.
- Speakeasy's current status of any traffic-capture product not confirmed.
- Optic's exact traffic-capture mechanism (proxy vs. HAR vs. test-harness) not confirmed from the archived README.

## Q3. PII/secret redaction approaches

### Takeaway
Shape-only capture is itself the strongest redaction (values never serialized), but field names and enum-like values can still leak PII (e.g., email addresses used as object keys, customer IDs in map keys). Industry practice combines: (1) strip all values client-side, (2) keyword + regex detection on keys/values, (3) keyed hashing (HMAC) for anything retained, (4) a fail-closed allowlist at the collector. Presidio-style NER is relevant only if SHAPI retains value samples (e.g., enum candidates).

### Cited Findings
- Postman Insights: strips values but not identifiers (keys) before upload; keyword list for sensitive keys and ~100 regexes for secrets; optional PII regexes — [Postman repro mode security](https://learning.postman.com/latest-v-12/docs/insights/data/repro-mode-security); [Postman redactions](https://learning.postman.com/docs/insights/data/redactions)
- Postman acknowledges regex/keyword redaction is imperfect (unrecognized secrets may be stored up to 30 days) — [Postman repro mode security](https://learning.postman.com/latest-v-12/docs/insights/data/repro-mode-security)
- OTel redaction processor: fail-closed allowlist, regex masking, HMAC-SHA256/512 hashing with key from env, recommended for low-entropy values — [redactionprocessor README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)
- Treblle: in-SDK masking before data leaves the server, same-length asterisks (note: same-length masking leaks value length) — [Treblle data masking](https://docs.treblle.com/treblle/data-masking/)
- Levo vendor claim of stripping payloads at the edge sensor — [Levo G2](https://www.g2.com/sellers/levo-fed6d6f5-ba0b-4b0c-9a31-6bfb424af86c)

### Inferences
- Recommended SHAPI pipeline: (a) in-process, compute shape only: path, JSON type, value class (e.g., `iso8601`, `uuid`, `email-like`, `int-range`, `enum-candidate`), nullability, array length bucket; never serialize the value; (b) detect "map-like" objects (keys that look like IDs/emails/high-cardinality) and collapse them to `{<dynamic-key>: shape}` so keys can't leak PII; (c) for enum detection, send only HMAC(salt_per_customer, value) plus count for short, low-cardinality strings, and reveal plaintext only for values that also appear in the provider's public docs/OpenAPI (or are seen across many customers — k-anonymity threshold); (d) run the OTel redaction processor with an allowlist of SHAPI attribute keys as a second, fail-closed layer.
- Salted field-name hashing would defeat cross-customer comparison of third-party API shapes (the main SHAPI value). Better: keep field names plaintext for paths that exist in the provider's published schema or were seen across >=k customers; hash only unknown/dynamic keys.
- Avoid Treblle-style length-preserving masks; length is a side channel.

### Gaps
- Did not fetch Microsoft Presidio docs this session (license, recognizers, performance); Presidio is generally known as MIT-licensed Python with regex+NER recognizers, but this is unverified here.
- No sources found on k-anonymity thresholds used by API-observability vendors.

## Q4. Shape/schema inference from JSON samples and diffing; standard breaking-change taxonomy

### Takeaway
Use oasdiff (Apache-2.0, Go library, ERR/WARN/INFO levels, hundreds of checks, OpenAPI 3.0/3.1/3.2) as the diff engine and taxonomy backbone by converting SHAPI's inferred shapes into OpenAPI response schemas; use genson-style merge semantics (MIT, Python) or quicktype-style union/nullable inference as reference designs for the inferrer, but keep SHAPI's own inferrer because neither does value classes, enum detection by default, or per-field statistics. Google AIP-180 and Stripe's upgrade docs give the clearest prose taxonomy (removal/rename, type change, format change, default/serialization change, new enum values in responses).

### Cited Findings
**Inference**
- GenSON (MIT, Python + CLI): generates JSON Schema from samples; `add_object()` and `add_schema()` merge many samples/schemas; same-type inputs merge, `anyOf` only for fundamentally different structures; compatible with Draft 6+ using a subset of keywords; never infers `enum` unless seeded with an `enum` keyword; extensible via `SchemaStrategy` subclasses; ~736 stars at fetch time — [GenSON repo](https://github.com/wolverdude/GenSON)
- quicktype merges type graphs from multiple samples, creating unions where values differ; a field null in one sample and string in another becomes nullable string; a field missing from some samples becomes non-required — [quicktype multiple samples blog](https://quicktype.io/blog/quicktype-multiple-samples)
- quicktype turns repeated string literals into enums when the set looks closed; a third-party guide says quicktype's JSON Schema output omits enum values and emits draft-06 (unverified against quicktype docs) — [quicktype llms-full](https://quicktype.io/llms-full.txt); [dottxt quicktype guide](https://docs.dottxt.ai/json-schema/quicktype)
- quicktype FAQ: can unify types across a directory of API responses — [quicktype FAQ (fork)](https://github.com/doggy8088/quicktype/blob/master/FAQ.md)
- Optic (archived Jan 2026, MIT) did OpenAPI diffing and spec generation from test traffic — [opticdev/optic](https://github.com/opticdev/optic)

**Diffing**
- oasdiff: Apache-2.0, ~1.4k stars, embeddable as a Go library, uses kin-openapi; docs cover OpenAPI 3.0 and "OpenAPI 3.1 and 3.2 support" and an `upgrade` command for 3.0 specs — [oasdiff repo](https://github.com/oasdiff/oasdiff)
- oasdiff supports "hundreds of checks" (list via `oasdiff checks changelog`) at three levels: ERR (definite breaking), WARN (potentially breaking), INFO (non-breaking); `breaking` reports ERR+WARN; per-check severity overrides (`err`/`warn`/`info`/`none`); adding a required request property is breaking even with a default; nullability changes are evaluated by request vs response direction (NULLABILITY.md); `x-extensible-enum` allows adding response enum values without a breaking error; deprecation-before-removal avoids an error (DEPRECATION.md) — [oasdiff BREAKING-CHANGES.md](https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md)

**Taxonomies**
- Google AIP-180 defines source, wire and semantic compatibility. Breaking: removing or renaming any component (rename = remove + add), moving fields into/out of a oneof, changing a field's type even if wire-compatible, changing value format/generation (e.g., IPv4 to IPv6), changing static defaults, changing whether default-valued fields are serialized, changing resource names, and visible semantic changes. Allowed with care: adding fields/enum values; new required fields not allowed on existing requests; server-populated fields must keep being populated; adding pagination can break; response enum additions need caution — [AIP-180](https://google.aip.dev/180)
- Stripe considers backward-compatible: new resources, new optional request parameters, new response properties, changed order of response properties — [Stripe API upgrades](https://docs.stripe.com/upgrades)
- Stripe distinguishes closed vs open enums and may add values to open enums without a version upgrade, advising a default/fallback branch — [Stripe enums](https://docs.stripe.com/api/enums); yet some Stripe changelog entries that add enum values are tagged breaking — [Stripe changelog 2024-06-20](https://docs.stripe.com/changelog/2024-06-20/adds-enum-disabled-reasons-capabilities); [Stripe changelog 2025-09-30](https://docs.stripe.com/changelog/clover/2025-09-30/risk-levels-issuing-authorizations)

### Inferences
- There is no single industry standard taxonomy; the de facto machine-readable one is oasdiff's check catalog, and the de facto prose ones are AIP-180 and Stripe's upgrade docs. SHAPI should publish its own taxonomy mapped to oasdiff check IDs plus SHAPI-only "observed" classes that spec diffs can't see: status-code drift, header drift, value-format drift (AIP-180's "format change"), field-presence drift (field present in 100% -> 60% of responses), and nullability drift.
- Pipeline: SHAPI shape (with per-field stats) -> project to an OpenAPI 3.1 response schema per (endpoint template, status) -> oasdiff (as a Go library or CLI) for structural checks; keep SHAPI's homegrown diff for statistical/value-class checks oasdiff can't express. Mark observed enums as `x-extensible-enum` by default so new values become INFO/WARN, then escalate based on provider's enum openness (Stripe's open vs closed enum docs).
- Spectral is a linter (style/governance rules), not a diff tool; not needed for SHAPI's diff path (from general knowledge; not verified this session).
- Because samples are partial, "removed field" must be inferred statistically (absence over N samples where previously present at rate p), not from a single missing occurrence — quicktype's "missing in some samples -> optional" rule shows why naive merging hides removals.

### Gaps
- Exact oasdiff check count and latest release version/date not stated on fetched pages.
- Did not evaluate openapi-diff (OpenAPITools/Java), json-schema-diff tools, or json-schema-inferrer (Java) this session.
- Did not confirm Spectral's current ownership/maintenance status (Stoplight acquired by SmartBear is background knowledge, unverified here).

## Q5. Statistical "semantic drift" detection over distributions (enum sets, null rates)

### Takeaway
Direct prior art for statistical drift on third-party API responses was not found. The nearest prior art is data observability (Monte Carlo-style null-rate, cardinality, and schema-snapshot monitors) and ML drift tooling; SHAPI would be applying table-column drift techniques to JSON field paths, which appears to be a genuine gap.

### Cited Findings
- Data observability practice: monitor null-rate surges with thresholds and run as part of ETL/CI; compare schema against stored snapshots/checksums to detect schema changes — [Monte Carlo: build your own anomaly detectors](https://montecarlodata.com/blog-how-to-build-your-own-data-anomaly-detectors-using-sql)
- Distribution drift framed as a column's mean, null rate, or cardinality shifting from historical patterns — [HackerNoon: data observability nulls/drift](https://hackernoon.com/building-data-observability-monitoring-nulls-drift-freshness-and-business-impact)
- Postman Insights tracks endpoints, errors, latency and volume from observed traffic (operational metrics, not field-distribution drift) — [postman-insights-agent repo](https://github.com/postmanlabs/postman-insights-agent)
- AIP-180's "semantic compatibility" and "value format change" categories (e.g., IPv4 -> IPv6) are exactly the class of change only distributional/value-class monitoring can detect — [AIP-180](https://google.aip.dev/180)

### Inferences
- Treat each (provider, endpoint template, status, field path) as a column: track presence rate, null rate, type mix, value-class mix, enum-candidate set (as HMACs + counts), and array-length buckets. Alert using a population-change test (e.g., chi-square or Jensen-Shannon divergence over value-class/type histograms; two-proportion z-test for null/presence rates) across rolling windows, gated by minimum sample counts.
- Cross-customer aggregation is SHAPI's edge: a drift seen simultaneously across many customers' egress for the same provider endpoint is strong evidence of a provider-side change rather than a customer-specific code path.
- New enum value detection: a never-before-seen HMAC in a historically low-cardinality field that appears across multiple tenants -> "new enum value" candidate; reveal plaintext only if it matches the provider's public docs or a canary probe observes it.

### Gaps
- No sources found on Great Expectations, Evidently, or deequ specifically applied to API responses; no academic papers found on API response distribution drift in this session.
- No public evidence found that Postman Insights, Treblle, or Levo do statistical field-level drift alerting.
