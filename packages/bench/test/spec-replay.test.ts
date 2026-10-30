import { describe, expect, it } from "vitest";
import { AdvisorySchema } from "@shapi/core";
import { changeMatchesGithubEntry, changeMatchesRow, diffSpecs, draftAdvisory, operationsReturning, parseEntryChanges, parseGithubBreakingChanges, parseReleasePage, previewOnly, resourceKey, scoreGithubReplay, scoreRelease, type ChangelogEntry } from "@shapi/bench";

// Execution plan P-08: spec-history replay. Two tiny versions of a Stripe-shaped spec.
const form = (props: Record<string, unknown>, required: string[] = []) => ({ content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: props, required } } } });
const ok = (ref: string) => ({ "200": { content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } } });
const before = {
  info: { version: "2025-09-30.clover" },
  paths: {
    "/v1/payment_intents": { post: { requestBody: form({ amount: { type: "integer" }, payment_method_types: { type: "array" }, capture_method: { type: "string", enum: ["automatic", "manual", "automatic_async"] } }), responses: ok("payment_intent") } },
    "/v1/payment_intents/{intent}": { get: { responses: ok("payment_intent") } },
    "/v1/sources": { get: { responses: ok("source") } },
  },
  components: {
    schemas: {
      payment_intent: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["succeeded", "processing", "requires_capture"] }, charges: { type: "object" }, next_action: { type: "object", properties: { redirect_url: { type: "string" } } } } },
      source: { type: "object", properties: { id: { type: "string" } } },
    },
  },
};
const after = {
  info: { version: "2026-03-25.dahlia" },
  paths: {
    "/v1/payment_intents": { post: { requestBody: form({ amount: { type: "integer" }, currency: { type: "string" }, capture_method: { type: "string", enum: ["automatic", "manual"] } }, ["currency"]), responses: ok("payment_intent") } },
    "/v1/payment_intents/{intent}": { get: { responses: ok("payment_intent") } },
  },
  components: {
    schemas: {
      payment_intent: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["succeeded", "processing"] }, charges: { type: "string", nullable: true }, next_action: { type: "object", properties: {} } } },
    },
  },
};

describe("spec-history replay (P-08)", () => {
  it("finds what a client could trip over between two versions of a spec", () => {
    const changes = diffSpecs(before as never, after as never);
    expect(changes.map((c) => `${c.kind} ${c.operation ?? c.schema} ${c.field ?? ""} ${c.values?.join(",") ?? ""}`.trim())).toEqual([
      "parameter-removed POST /v1/payment_intents payment_method_types",
      "enum-value-removed POST /v1/payment_intents capture_method automatic_async",
      "parameter-required POST /v1/payment_intents currency",
      "operation-removed GET /v1/sources",
      "enum-value-removed payment_intent status requires_capture",
      "property-type-changed payment_intent charges",
      "property-removed payment_intent next_action.redirect_url",
      "schema-removed source",
    ]);
  });

  it("maps each change to a change class, and drafts it as a valid unverified advisory", () => {
    const changes = diffSpecs(before as never, after as never);
    const returning = operationsReturning(before as never);
    expect(returning.get("payment_intent")).toEqual(["POST /v1/payment_intents", "GET /v1/payment_intents/{intent}"]);
    const drafts = changes.map((c) => draftAdvisory(c, { provider: "stripe", version: "2026-03-25.dahlia", returning, sources: ["https://github.com/stripe/openapi"] }));
    for (const d of drafts) expect(AdvisorySchema.parse(d)).toEqual(d);
    expect(new Set(drafts.map((d) => d.status))).toEqual(new Set(["unverified"]));
    const removedParam = drafts.find((d) => d.trigger.body?.[0]?.field === "payment_method_types")!;
    expect(removedParam).toMatchObject({ changeClass: "required-field", endpoint: { method: "POST", path: "/v1/payment_intents" }, effectiveDate: "2026-03-25" });
    const status = drafts.find((d) => d.trigger.enums?.[0]?.field === "status")!;
    expect(status).toMatchObject({ changeClass: "enum-added", endpoint: { method: "*", path: "/v1/payment_intents/**" }, trigger: { enums: [{ field: "status", values: ["requires_capture"] }] } });
  });

  it("reads a release page's Breaking and Non-breaking rows, and an entry's REST API table", () => {
    const page = [
      "| Title | Affected Products | Breaking change? | Category |",
      "| --- | --- | --- | --- |",
      "| [Removes support for specifying payment method types](https://docs.stripe.com/changelog/dahlia/2026-03-25/removes-payment-method-types.md) | Payments | Breaking | api |",
      "| [Adds a funding source identifier](https://docs.stripe.com/changelog/dahlia/2026-08-26/adds-funding.md) | Payments | Non-breaking | api |",
    ].join("\n");
    expect(parseReleasePage(page)).toEqual([
      { title: "Removes support for specifying payment method types", url: "https://docs.stripe.com/changelog/dahlia/2026-03-25/removes-payment-method-types.md", date: "2026-03-25", breaking: true, category: "api" },
      { title: "Adds a funding source identifier", url: "https://docs.stripe.com/changelog/dahlia/2026-08-26/adds-funding.md", date: "2026-08-26", breaking: false, category: "api" },
    ]);
    const entry = [
      "## Changes",
      "",
      "#### REST API",
      "",
      "| Parameter | Change | Resources or endpoints |",
      "| --- | --- | --- |",
      "| `payment_method_types` | Removed | [PaymentIntent#confirm](/api/x), [PaymentIntent#create](/api/y), [SetupIntent#create](/api/z) |",
      "",
      "#### Ruby",
      "",
      "| `payment_method_types` | Removed | [PaymentIntentCreateParams](/api/y) |",
    ].join("\n");
    expect(parseEntryChanges(entry)).toEqual([{ field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#confirm", "PaymentIntent#create", "SetupIntent#create"] }]);
    expect(parseEntryChanges("## What's new\n\nA behavior change.")).toEqual([]);
    // The two other table shapes: a field path holding its resource, and enum values with the field in the link anchor.
    const shapes = [
      "## Changes",
      "",
      "#### REST API",
      "",
      "| Fields | Change | From → to |",
      "| --- | --- | --- |",
      "| `Issuing.Token.network_data.visa.card_reference_id` | Changed | `string → nullable(string)` |",
      "| `Issuing.Card.wallets.apple_pay`, `Issuing.Card.wallets.google_pay` | Removed | |",
      "",
      "| Value | Change | Enums |",
      "| --- | --- | --- |",
      "| `custom`, `embedded`, `hosted` | Removed | [Checkout.Session#create](/api/checkout/sessions/create#create_checkout_session-ui_mode) |",
      "",
      "## Upgrade",
    ].join("\n");
    expect(parseEntryChanges(shapes)).toEqual([
      { field: "network_data.visa.card_reference_id", change: "Changed", resources: ["Issuing.Token"] },
      { field: "wallets.apple_pay", change: "Removed", resources: ["Issuing.Card"] },
      { field: "wallets.google_pay", change: "Removed", resources: ["Issuing.Card"] },
      { field: "ui_mode", change: "Removed", resources: ["Checkout.Session#create"], values: ["custom", "embedded", "hosted"] },
    ]);
  });

  it("matches a spec change to a changelog row by field and resource", () => {
    expect(resourceKey("PaymentIntent#create")).toBe("payment_intent");
    const row = { field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#create"] };
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/payment_intents", field: "payment_method_types", detail: "" }, row)).toBe(true);
    expect(changeMatchesRow({ kind: "property-removed", changeClass: "field-rename", schema: "payment_intent", field: "payment_method_types", detail: "" }, row)).toBe(true);
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/charges", field: "payment_method_types", detail: "" }, row)).toBe(false);
    expect(changeMatchesRow({ kind: "parameter-removed", changeClass: "required-field", operation: "POST /v1/payment_intents", field: "amount", detail: "" }, row)).toBe(false);
  });

  it("scores recall against GA breaking rows, false positives against non-breaking rows, and behavior-only rows", () => {
    const changes = diffSpecs(before as never, after as never);
    const entry = (title: string, breaking: boolean, rest: ChangelogEntry["rest"], date = "2026-03-25", category = "api"): ChangelogEntry => ({ title, url: `https://docs.stripe.com/changelog/dahlia/${date}/${title}.md`, date, breaking, category, rest });
    const score = scoreRelease({
      release: "dahlia",
      version: "2026-03-25.dahlia",
      before: { sha: "a", version: "2025-09-30.clover" },
      after: { sha: "b", version: "2026-03-25.dahlia" },
      changes,
      entries: [
        entry("found", true, [{ field: "payment_method_types", change: "Removed", resources: ["PaymentIntent#create"] }]),
        entry("behavior", true, []),
        entry("missed", true, [{ field: "unknown_field", change: "Removed", resources: ["Charge"] }]),
        entry("additive", false, [{ field: "status", change: "Changed", resources: ["PaymentIntent"] }]),
        entry("preview", true, [{ field: "amount", change: "Removed", resources: ["PaymentIntent#create"] }], "2026-08-26"),
        entry("stripejs", true, [], "2026-03-25", "stripejs"),
        { ...entry("preview-api", true, [{ field: "destination", change: "Added", resources: ["Reserve.Plan"] }]), preview: true },
        entry("v2", true, [{ field: "configurations", change: "Removed", resources: ["v2.core.AccountLink#create"] }]),
      ],
    });
    expect(score).toMatchObject({ breakingEntries: 5, clientOnly: 1, breakingFound: 1, behaviorOnly: 1, outsideSpec: 1, previewOnly: 1, breakingMissed: 1, candidatesMatchingBreaking: 1, candidatesMatchingNonBreaking: 1, nonBreakingEntriesMatched: 1 });
    expect(score.missed.map((m) => m.reason)).toEqual(["no REST field change listed: a behavior change", "no spec change matches unknown_field (Removed)", "a preview API, which the GA spec does not carry", "a v2 API, which stripe/openapi does not publish"]);
    expect(previewOnly("[x](/api/reserve/plans?api-version=2026-09-30.preview#a) [y](/api/b?api-version=2026-09-30.preview)")).toBe(true);
    expect(previewOnly("[x](/api/a?api-version=2026-09-30.preview) [y](/api/b?api-version=2026-09-30.endive)")).toBe(false);
    expect(previewOnly("A behavior change.")).toBe(false);
  });
});

describe("spec-history replay for GitHub (P-09)", () => {
  const page = [
    "# Breaking changes",
    "",
    "## Version 2026-03-10",
    "",
    "* **Remove deprecated `rate` property from rate limit endpoint**",
    "  The `rate` property has been deprecated since 2021.",
    "",
    "  <details>",
    "  <summary><strong>Affected endpoints</strong></summary>",
    "",
    "  * `GET /rate_limit`",
    "",
    "  </details>",
    "",
    "* **Remove deprecated singular \"assignee\" field from Issue and Pull Request endpoints**",
    "",
    "  * `POST /repos/{owner}/{repo}/issues`",
    "",
    "* **Change accept repository invitation response from `403` to `451` when blocked by",
    "  trade controls**",
    "",
    "  * `PATCH /user/repository_invitations/{invitation_id}`",
    "",
    "* **Deprecate support for the `beta` media type**",
    "",
    "## Version 2022-11-28",
    "",
    "* **Not this one**",
  ].join("\n");

  it("reads one version's entries: wrapped titles, affected endpoints, and the names a title quotes", () => {
    expect(parseGithubBreakingChanges(page, "2026-03-10")).toEqual([
      { title: "Remove deprecated `rate` property from rate limit endpoint", endpoints: ["GET /rate_limit"], names: ["rate"] },
      { title: 'Remove deprecated singular "assignee" field from Issue and Pull Request endpoints', endpoints: ["POST /repos/{owner}/{repo}/issues"], names: ["assignee"] },
      { title: "Change accept repository invitation response from `403` to `451` when blocked by trade controls", endpoints: ["PATCH /user/repository_invitations/{invitation_id}"], names: ["403", "451"] },
      { title: "Deprecate support for the `beta` media type", endpoints: [], names: ["beta"] },
    ]);
  });

  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const v1 = {
    info: { version: "2022-11-28" },
    paths: {
      "/rate_limit": { get: { responses: { "200": json({ $ref: "#/components/schemas/rate-limit-overview" }) } } },
      "/repos/{owner}/{repo}/issues": { post: { parameters: [{ $ref: "#/components/parameters/owner" }], requestBody: json({ type: "object", properties: { title: { type: "string" }, assignee: { type: "string" } } }), responses: { "201": json({}) } } },
      "/user/repository_invitations/{invitation_id}": { patch: { responses: { "204": {}, "403": {} } } },
      "/repos/{owner}/{repo}/code-scanning/default-setup": { get: { responses: { "200": json({ type: "array", items: { $ref: "#/components/schemas/default-setup" } }) } } },
    },
    components: {
      parameters: { owner: { name: "owner", in: "path", required: true, schema: { type: "string" } } },
      schemas: {
        "rate-limit-overview": { type: "object", properties: { rate: { type: "object" }, resources: { type: "object" } } },
        "default-setup": { type: "object", properties: { languages: { type: "array", items: { type: "string", enum: ["python", "javascript", "javascript-typescript"] } } } },
      },
    },
  };
  const v2 = structuredClone(v1);
  delete (v2.components.schemas["rate-limit-overview"].properties as Record<string, unknown>).rate;
  v2.paths["/repos/{owner}/{repo}/issues"].post.requestBody = json({ type: "object", properties: { title: { type: "string" } } });
  (v2.paths["/user/repository_invitations/{invitation_id}"].patch.responses as Record<string, unknown>)["451"] = {};
  v2.components.schemas["default-setup"].properties.languages.items.enum = ["python", "javascript-typescript"];

  it("diffs JSON bodies, shared parameters, array responses and enums on array items; new statuses only when asked", () => {
    const show = (opts?: { statusAdded?: boolean }) => diffSpecs(v1 as never, v2 as never, opts).map((c) => `${c.kind} ${c.operation ?? c.schema} ${c.field ?? ""} ${c.values?.join(",") ?? ""}`.trim());
    expect(show()).toEqual([
      "parameter-removed POST /repos/{owner}/{repo}/issues assignee",
      "property-removed rate-limit-overview rate",
      "enum-value-removed default-setup languages javascript",
    ]);
    expect(show({ statusAdded: true })).toContain("response-status-added PATCH /user/repository_invitations/{invitation_id} 451");
    // A shared parameter is read through its $ref: it is there in both versions, so it is not reported.
    expect(show().some((c) => c.endsWith(" owner"))).toBe(false);
    expect(operationsReturning(v1 as never).get("default-setup")).toEqual(["GET /repos/{owner}/{repo}/code-scanning/default-setup"]);
  });

  it("scores entries found, behavior-only and missed, and the changes no entry lists", () => {
    const changes = diffSpecs(v1 as never, v2 as never, { statusAdded: true });
    const entries = parseGithubBreakingChanges(page, "2026-03-10");
    const returning = operationsReturning(v1 as never);
    expect(changeMatchesGithubEntry(changes.find((c) => c.field === "rate")!, entries[0]!, returning)).toBe(true);
    expect(changeMatchesGithubEntry(changes.find((c) => c.field === "rate")!, entries[1]!, returning)).toBe(false);
    const score = scoreGithubReplay({ version: "2026-03-10", previous: "2022-11-28", commit: "abc", changes, entries, returning, supportedVersions: ["2026-03-10", "2022-11-28"] });
    expect(score).toMatchObject({ breakingEntries: 4, found: 3, behaviorOnly: 1, candidates: 4, candidatesMatching: 3, candidatesUnlisted: 1 });
    expect(score.missed).toEqual([{ title: "Deprecate support for the `beta` media type", reason: "a behavior change: no field, value or status code in the spec shows it" }]);
    // Drafts for GitHub changes validate too, with GitHub's name in them.
    const drafts = changes.map((c) => AdvisorySchema.parse(draftAdvisory(c, { provider: "github", providerName: "GitHub", version: "2026-03-10", returning, sources: ["https://docs.github.com"] })));
    expect(drafts.every((d) => d.summary.includes("GitHub's published specs") && d.status === "unverified")).toBe(true);
    expect(drafts.find((d) => d.trigger.any)?.endpoint).toEqual({ method: "PATCH", path: "/user/repository_invitations/{invitation_id}" });
  });
});
